//! GitHub-release based update channel.
//!
//! The app has no updater signing infrastructure, so this is a lightweight
//! flow: query the latest published GitHub release, compare semver, download
//! the platform installer asset with progress events, then run it (Windows
//! NSIS installs over the current app; macOS opens the .dmg for drag-install).

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::NexError;

/// GitHub repository that publishes releases (matches `git remote origin`).
pub const GITHUB_REPO: &str = "jianjunx/nex";
/// Browser-friendly repo page shown in the About section.
pub const GITHUB_REPO_URL: &str = "https://github.com/jianjunx/nex";

const API_TIMEOUT: Duration = Duration::from_secs(15);
/// Event emitted while streaming the installer to disk.
pub const EVENT_UPDATE_DOWNLOAD_PROGRESS: &str = "update-download-progress";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_name: String,
    pub release_url: String,
    pub release_notes: String,
    /// Installer asset for the current platform, if the release ships one.
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateDownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    /// 0..=100; `None` when the server sent no Content-Length.
    pub percent: Option<u8>,
}

fn http_client(timeout: Option<Duration>) -> Result<reqwest::Client, NexError> {
    let mut builder = reqwest::Client::builder()
        .user_agent("nex-updater")
        .connect_timeout(Duration::from_secs(15));
    if let Some(t) = timeout {
        builder = builder.timeout(t);
    }
    builder
        .build()
        .map_err(|e| NexError::Internal(format!("http client: {e}")))
}

/// Pick the installer asset for the current platform from a release's assets.
fn pick_asset(assets: &[serde_json::Value]) -> Option<(String, String)> {
    for a in assets {
        let name = a.get("name")?.as_str()?;
        let url = a.get("browser_download_url")?.as_str()?;
        #[cfg(target_os = "windows")]
        if name.ends_with("-setup.exe") {
            return Some((name.to_string(), url.to_string()));
        }
        #[cfg(target_os = "macos")]
        if name.ends_with(".dmg") {
            return Some((name.to_string(), url.to_string()));
        }
    }
    None
}

/// Query GitHub for the latest published release and compare against the
/// running version. Drafts/prereleases are excluded by the `/latest` endpoint.
#[tauri::command]
pub async fn update_check_latest(app: AppHandle) -> Result<UpdateInfo, NexError> {
    let current_version = app.package_info().version.to_string();
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
    let client = http_client(Some(API_TIMEOUT))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| NexError::Internal(format!("查询更新失败: {e}")))?;
    if !resp.status().is_success() {
        return Err(NexError::Internal(format!(
            "查询更新失败: GitHub 返回 {}",
            resp.status()
        )));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| NexError::Internal(format!("解析更新信息失败: {e}")))?;

    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| NexError::Internal("GitHub 响应缺少 tag_name".into()))?;
    let latest_version = tag.trim_start_matches('v').to_string();

    let assets = body
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let (asset_name, asset_url) = match pick_asset(&assets) {
        Some((n, u)) => (Some(n), Some(u)),
        None => (None, None),
    };

    let update_available = match (
        semver::Version::parse(&current_version),
        semver::Version::parse(&latest_version),
    ) {
        (Ok(cur), Ok(latest)) => latest > cur,
        // Unparseable tags: don't nag, let the user inspect the release page.
        _ => false,
    };

    Ok(UpdateInfo {
        current_version,
        latest_version: latest_version.clone(),
        update_available,
        release_name: body
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&latest_version)
            .to_string(),
        release_url: body
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or(GITHUB_REPO_URL)
            .to_string(),
        release_notes: body
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        asset_name,
        asset_url,
    })
}

/// Download the installer asset to the app-data dir (with progress events),
/// then launch it. Windows: runs the NSIS installer and exits so files can be
/// replaced. macOS: opens the .dmg for the user to drag-install.
#[tauri::command]
pub async fn update_download_and_install(
    app: AppHandle,
    asset_url: String,
    asset_name: String,
) -> Result<(), NexError> {
    // Refuse path traversal — the name comes from GitHub but we still
    // treat it as untrusted input.
    if asset_name.is_empty()
        || asset_name.contains('/')
        || asset_name.contains('\\')
        || asset_name.contains("..")
    {
        return Err(NexError::Internal(format!("非法安装包文件名: {asset_name}")));
    }

    let client = http_client(None)?;
    let resp = client
        .get(&asset_url)
        .send()
        .await
        .map_err(|e| NexError::Internal(format!("下载安装包失败: {e}")))?;
    if !resp.status().is_success() {
        return Err(NexError::Internal(format!(
            "下载安装包失败: 服务器返回 {}",
            resp.status()
        )));
    }
    let total = resp.content_length();

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| NexError::Internal(format!("无法定位数据目录: {e}")))?
        .join("updater");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| NexError::Internal(format!("创建更新目录失败: {e}")))?;
    let dest = dir.join(&asset_name);
    // A stale partial download from a previous attempt must not survive.
    let _ = tokio::fs::remove_file(&dest).await;

    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| NexError::Internal(format!("创建安装包文件失败: {e}")))?;
    use tokio::io::AsyncWriteExt;
    let mut downloaded: u64 = 0;
    let mut last_percent: i64 = -1;
    let mut resp = resp;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| NexError::Internal(format!("下载安装包失败: {e}")))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| NexError::Internal(format!("写入安装包失败: {e}")))?;
        downloaded += chunk.len() as u64;
        let percent = total.map(|t| ((downloaded * 100) / t.max(1)).min(100) as i64);
        // Throttle: emit only when the integer percent advances.
        if percent != Some(last_percent) {
            if let Some(p) = percent {
                last_percent = p;
            }
            let _ = app.emit(
                EVENT_UPDATE_DOWNLOAD_PROGRESS,
                UpdateDownloadProgress {
                    downloaded,
                    total,
                    percent: percent.map(|p| p as u8),
                },
            );
        }
    }
    file.flush()
        .await
        .map_err(|e| NexError::Internal(format!("写入安装包失败: {e}")))?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&dest)
            .spawn()
            .map_err(|e| NexError::Internal(format!("启动安装程序失败: {e}")))?;
        // Exit so the NSIS installer can replace the running binaries.
        app.exit(0);
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dest)
            .spawn()
            .map_err(|e| NexError::Internal(format!("打开安装镜像失败: {e}")))?;
    }

    Ok(())
}

/// Open an https URL in the system browser. Only github.com is allowed —
/// this is the only external link surface the app has.
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), NexError> {
    // Host allowlist instead of a URL parser dependency; this is the only
    // external link surface, so a strict prefix check is enough.
    let allowed = url.starts_with("https://github.com/")
        || url == "https://github.com"
        || url.starts_with("https://www.github.com/");
    if !allowed {
        return Err(NexError::Internal("仅允许打开 github.com 链接".into()));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| NexError::Internal(format!("打开浏览器失败: {e}")))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| NexError::Internal(format!("打开浏览器失败: {e}")))?;
    }
    Ok(())
}
