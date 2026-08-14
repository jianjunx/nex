//! Agent binary cache: downloads and extracts binary-only agent distributions
//! (zip or tar.gz archives) on first use, then reuses the cached copy forever.
//!
//! Mirrors the approach Zed takes in
//! `crates/agent_servers/src/binary.rs`: download archive, verify optional
//! sha256, extract into a versioned directory, then spawn the `cmd` relative to
//! the extraction root.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::registry::{RegistryEntry, RegistryBinaryTarget};
use crate::error::NexError;

#[derive(Clone)]
pub struct BinaryCache {
    root: PathBuf,
    background_updates: Arc<Mutex<HashSet<String>>>,
}

impl BinaryCache {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            root: app_data_dir.join("agent-binaries"),
            background_updates: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Returns the path to the cached executable, downloading and extracting
    /// the archive if this agent version has never been installed before.
    pub async fn ensure_installed(
        &self,
        entry: &RegistryEntry,
        target: &RegistryBinaryTarget,
        platform_key: &str,
    ) -> Result<PathBuf, NexError> {
        let install_dir = self.install_dir(entry, platform_key);
        let marker = install_dir.join(".nex-install-ok");

        if marker.exists() {
            let exe = install_dir.join(&target.cmd);
            if exe.exists() {
                let _ = touch_marker(&marker);
                return Ok(exe);
            }
        }

        if let Some((exe, cached_marker)) =
            self.newest_usable_install(&entry.id, platform_key, &target.cmd)
        {
            let _ = touch_marker(&cached_marker);
            self.prefetch(entry.clone(), target.clone(), platform_key.to_string());
            return Ok(exe);
        }

        self.ensure_exact_installed(entry, target, platform_key).await
    }

    fn install_dir(&self, entry: &RegistryEntry, platform_key: &str) -> PathBuf {
        self.root
            .join(sanitize(&entry.id))
            .join(sanitize(&entry.version))
            .join(sanitize(platform_key))
    }

    async fn ensure_exact_installed(
        &self,
        entry: &RegistryEntry,
        target: &RegistryBinaryTarget,
        platform_key: &str,
    ) -> Result<PathBuf, NexError> {
        // Validate metadata before downloading a large archive that could
        // never pass the mandatory integrity check.
        let Some(expected) = &target.sha256 else {
            return Err(NexError::Agent(format!(
                "agent 分发缺少 sha256 校验值，拒绝安装: {}",
                entry.id
            )));
        };

        let bytes = download_archive(&target.archive).await?;
        verify_sha256(&bytes, expected)?;

        let install_dir = self.install_dir(entry, platform_key);
        let marker = install_dir.join(".nex-install-ok");
        if install_dir.exists() {
            std::fs::remove_dir_all(&install_dir).map_err(|e| {
                NexError::Agent(format!("failed to wipe agent binary dir: {e}"))
            })?;
        }
        std::fs::create_dir_all(&install_dir).map_err(|e| {
            NexError::Agent(format!("failed to create agent binary dir: {e}"))
        })?;

        extract_archive(&bytes, &target.archive, &install_dir)?;

        std::fs::write(&marker, "").map_err(|e| {
            NexError::Agent(format!("failed to write install marker: {e}"))
        })?;

        Ok(install_dir.join(&target.cmd))
    }

    fn prefetch(&self, entry: RegistryEntry, target: RegistryBinaryTarget, platform_key: String) {
        let key = format!(
            "{}/{}/{}",
            sanitize(&entry.id),
            sanitize(&entry.version),
            sanitize(&platform_key)
        );
        {
            let mut updates = self.background_updates.lock().unwrap();
            if !updates.insert(key.clone()) {
                return;
            }
        }

        let cache = self.clone();
        tokio::spawn(async move {
            match cache.ensure_exact_installed(&entry, &target, &platform_key).await {
                Ok(_) => log::info!(
                    "silently installed binary agent update `{}` ({})",
                    entry.id,
                    entry.version
                ),
                Err(e) => log::warn!(
                    "silent binary agent update failed for `{}` ({}); keeping cached version: {e}",
                    entry.id,
                    entry.version
                ),
            }
            cache.background_updates.lock().unwrap().remove(&key);
        });
    }

    fn newest_usable_install(
        &self,
        agent_id: &str,
        platform_key: &str,
        command: &str,
    ) -> Option<(PathBuf, PathBuf)> {
        let versions = std::fs::read_dir(self.root.join(sanitize(agent_id))).ok()?;
        let mut newest: Option<(std::time::SystemTime, PathBuf, PathBuf)> = None;
        for version in versions.flatten() {
            let platform_dir = version.path().join(sanitize(platform_key));
            let marker = platform_dir.join(".nex-install-ok");
            let executable = platform_dir.join(command);
            if !executable.is_file() {
                continue;
            }
            let Ok(mtime) = std::fs::metadata(&marker).and_then(|m| m.modified()) else {
                continue;
            };
            match &newest {
                Some((previous, _, _)) if *previous >= mtime => {}
                _ => newest = Some((mtime, executable, marker)),
            }
        }
        newest.map(|(_, executable, marker)| (executable, marker))
    }

    pub fn newest_installed_version(&self, agent_id: &str, platform_key: &str) -> Option<String> {
        let versions = std::fs::read_dir(self.root.join(sanitize(agent_id))).ok()?;
        let mut newest: Option<(std::time::SystemTime, String)> = None;
        for version in versions.flatten() {
            let marker = version
                .path()
                .join(sanitize(platform_key))
                .join(".nex-install-ok");
            let Ok(mtime) = std::fs::metadata(marker).and_then(|m| m.modified()) else {
                continue;
            };
            let version_name = version.file_name().to_string_lossy().into_owned();
            match &newest {
                Some((previous, _)) if *previous >= mtime => {}
                _ => newest = Some((mtime, version_name)),
            }
        }
        newest.map(|(_, version)| version)
    }
}

fn touch_marker(path: &Path) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().write(true).open(path)?;
    file.write_all(b"")?;
    file.sync_data()
}

/// Hard cap on archive downloads so a stalled connection can't hang the
/// agent install forever.
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

async fn download_archive(url: &str) -> Result<Vec<u8>, NexError> {
    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| NexError::Agent(format!("failed to build download client: {e}")))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| NexError::Agent(format!("failed to download agent archive: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(NexError::Agent(format!(
            "failed to download agent archive (HTTP {status})"
        )));
    }

    response.bytes().await.map(|b| b.to_vec()).map_err(|e| {
        NexError::Agent(format!("failed to read agent archive body: {e}"))
    })
}

fn verify_sha256(data: &[u8], expected_hex: &str) -> Result<(), NexError> {
    use sha2::{Digest, Sha256};
    let actual = format!("{:x}", Sha256::digest(data));
    if actual != expected_hex {
        return Err(NexError::Agent(format!(
            "agent archive checksum mismatch\n  expected: {expected_hex}\n  actual:   {actual}"
        )));
    }
    Ok(())
}

fn extract_archive(data: &[u8], url: &str, dest: &Path) -> Result<(), NexError> {
    let lower = url.to_lowercase();

    if lower.ends_with(".zip") {
        extract_zip(data, dest)
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        extract_tar_gz(data, dest)
    } else if data.len() >= 2 {
        // Sniff magic bytes when the extension isn't clear.
        match (data[0], data[1]) {
            (0x50, 0x4B) => extract_zip(data, dest),
            (0x1F, 0x8B) => extract_tar_gz(data, dest),
            _ => Err(NexError::Agent(format!(
                "unsupported archive format (unrecognised extension/magic): {url}"
            ))),
        }
    } else {
        Err(NexError::Agent(format!(
            "empty or unsupported agent archive: {url}"
        )))
    }
}

fn extract_zip(data: &[u8], dest: &Path) -> Result<(), NexError> {
    let cursor = std::io::Cursor::new(data);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| NexError::Agent(format!("invalid zip: {e}")))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| NexError::Agent(format!("zip entry {i}: {e}")))?;

        let Some(path) = file.enclosed_name() else {
            continue;
        };
        let out_path = dest.join(&path);

        if file.name().ends_with('/') || file.name().ends_with('\\') {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| NexError::Agent(format!("mkdir: {e}")))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| NexError::Agent(format!("mkdir: {e}")))?;
            }
            let mut out = std::fs::File::create(&out_path)
                .map_err(|e| NexError::Agent(format!("create file: {e}")))?;
            std::io::copy(&mut file, &mut out)
                .map_err(|e| NexError::Agent(format!("write file: {e}")))?;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = file.unix_mode() {
                // Ensure owner-x is set for extracted executables.
                let _ = std::fs::set_permissions(
                    &out_path,
                    std::fs::Permissions::from_mode(mode | 0o100),
                );
            }
        }
    }

    Ok(())
}

fn extract_tar_gz(data: &[u8], dest: &Path) -> Result<(), NexError> {
    let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(data));
    let mut archive = tar::Archive::new(gz);
    archive
        .unpack(dest)
        .map_err(|e| NexError::Agent(format!("tar extract: {e}")))
}

/// Replaces characters that are trouble in filesystem paths.
fn sanitize(id: &str) -> String {
    id.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|', ' '], "_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::registry::{RegistryDistribution, RegistryEntry};
    use std::collections::HashMap;

    fn entry(version: &str) -> RegistryEntry {
        RegistryEntry {
            id: "cursor".to_string(),
            name: "Cursor".to_string(),
            version: version.to_string(),
            description: String::new(),
            icon: None,
            distribution: RegistryDistribution::default(),
        }
    }

    fn target(sha256: Option<&str>) -> RegistryBinaryTarget {
        RegistryBinaryTarget {
            archive: "https://example.invalid/cursor.tar.gz".to_string(),
            cmd: "dist-package/cursor-agent".to_string(),
            args: vec!["acp".to_string()],
            sha256: sha256.map(String::from),
            env: HashMap::new(),
        }
    }

    fn seed_binary(cache: &BinaryCache, version: &str, platform: &str, complete: bool) -> PathBuf {
        let dir = cache
            .root
            .join("cursor")
            .join(version)
            .join(platform);
        let executable = dir.join("dist-package/cursor-agent");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, "binary").unwrap();
        if complete {
            std::fs::write(dir.join(".nex-install-ok"), "").unwrap();
        }
        executable
    }

    #[tokio::test]
    async fn cached_binary_stays_active_until_update_marker_exists() {
        let dir = tempfile::tempdir().unwrap();
        let cache = BinaryCache::new(dir.path());
        let old = seed_binary(&cache, "2026.07.23", "darwin-aarch64", true);
        let _partial = seed_binary(&cache, "2026.08.11", "darwin-aarch64", false);

        let resolved = cache
            .ensure_installed(
                &entry("2026.08.11"),
                &target(None),
                "darwin-aarch64",
            )
            .await
            .unwrap();
        assert_eq!(resolved, old);
        assert_eq!(
            cache.newest_installed_version("cursor", "darwin-aarch64").as_deref(),
            Some("2026.07.23")
        );
    }

    #[tokio::test]
    async fn cold_binary_rejects_missing_checksum_before_creating_version_dir() {
        let dir = tempfile::tempdir().unwrap();
        let cache = BinaryCache::new(dir.path());
        let new_entry = entry("2026.08.11");
        let err = cache
            .ensure_installed(&new_entry, &target(None), "darwin-aarch64")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("sha256"));
        assert!(!cache.install_dir(&new_entry, "darwin-aarch64").exists());
    }
}
