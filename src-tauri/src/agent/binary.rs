//! Agent binary cache: downloads and extracts binary-only agent distributions
//! (zip or tar.gz archives) on first use, then reuses the cached copy forever.
//!
//! Mirrors the approach Zed takes in
//! `crates/agent_servers/src/binary.rs`: download archive, verify optional
//! sha256, extract into a versioned directory, then spawn the `cmd` relative to
//! the extraction root.

use std::path::{Path, PathBuf};

use super::registry::{RegistryEntry, RegistryBinaryTarget};
use crate::error::NexError;

pub struct BinaryCache {
    root: PathBuf,
}

impl BinaryCache {
    pub fn new(app_data_dir: &Path) -> Self {
        Self { root: app_data_dir.join("agent-binaries") }
    }

    /// Returns the path to the cached executable, downloading and extracting
    /// the archive if this agent version has never been installed before.
    pub async fn ensure_installed(
        &self,
        entry: &RegistryEntry,
        target: &RegistryBinaryTarget,
        platform_key: &str,
    ) -> Result<PathBuf, NexError> {
        let install_dir = self
            .root
            .join(sanitize(&entry.id))
            .join(&entry.version)
            .join(platform_key);
        let marker = install_dir.join(".nex-install-ok");

        if marker.exists() {
            let exe = install_dir.join(&target.cmd);
            if exe.exists() {
                return Ok(exe);
            }
        }

        std::fs::create_dir_all(&install_dir).map_err(|e| {
            NexError::Agent(format!("failed to create agent binary dir: {e}"))
        })?;

        let bytes = download_archive(&target.archive).await?;

        if let Some(expected) = &target.sha256 {
            verify_sha256(&bytes, expected)?;
        }

        extract_archive(&bytes, &target.archive, &install_dir)?;

        std::fs::write(&marker, "").map_err(|e| {
            NexError::Agent(format!("failed to write install marker: {e}"))
        })?;

        Ok(install_dir.join(&target.cmd))
    }
}

async fn download_archive(url: &str) -> Result<Vec<u8>, NexError> {
    let response = reqwest::get(url).await.map_err(|e| {
        NexError::Agent(format!("failed to download agent archive: {e}"))
    })?;

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
