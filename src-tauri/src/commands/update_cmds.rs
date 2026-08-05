//! GitHub-release based update channel.
//!
//! The app has no updater signing infrastructure, so this is a lightweight
//! flow: query the latest published GitHub release, compare semver, download
//! the platform installer asset with progress events, then run it (Windows
//! NSIS installs over the current app; macOS opens the .dmg for drag-install).
//!
//! Unauthenticated clients share a 60 req/h IP quota on `api.github.com`
//! (easy to exhaust on a NAT). We query REST `/releases?per_page=N` first
//! (includes prereleases; `/latest` does not), then fall back to the Atom
//! feed + `expanded_assets` HTML on 403/429/network failure. Successful
//! results are cached in-process for a few minutes.

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::NexError;

/// GitHub repository that publishes releases (matches `git remote origin`).
pub const GITHUB_REPO: &str = "jianjunx/nex";
/// Browser-friendly repo page shown in the About section.
pub const GITHUB_REPO_URL: &str = "https://github.com/jianjunx/nex";

const API_TIMEOUT: Duration = Duration::from_secs(15);
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
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

#[derive(Debug, Clone)]
struct ReleaseSnapshot {
    /// Tag with optional leading `v` stripped for semver compare.
    latest_version: String,
    release_name: String,
    release_url: String,
    release_notes: String,
    /// `(filename, absolute download URL)`.
    assets: Vec<(String, String)>,
}

struct CachedCheck {
    at: Instant,
    info: UpdateInfo,
}

static CHECK_CACHE: Mutex<Option<CachedCheck>> = Mutex::new(None);

fn http_client(timeout: Option<Duration>) -> Result<reqwest::Client, NexError> {
    let mut builder = reqwest::Client::builder()
        // GitHub rejects empty / generic agents; include a contact URL.
        .user_agent(format!("nex-updater ({GITHUB_REPO_URL})"))
        .connect_timeout(Duration::from_secs(15));
    if let Some(t) = timeout {
        builder = builder.timeout(t);
    }
    builder
        .build()
        .map_err(|e| NexError::Internal(format!("http client: {e}")))
}

/// Pick the installer asset for the current platform from name/url pairs.
fn pick_asset_pair(assets: &[(String, String)]) -> Option<(String, String)> {
    for (name, url) in assets {
        #[cfg(target_os = "windows")]
        if name.ends_with("-setup.exe") {
            return Some((name.clone(), url.clone()));
        }
        #[cfg(target_os = "macos")]
        if name.ends_with(".dmg") {
            return Some((name.clone(), url.clone()));
        }
        let _ = (name, url);
    }
    None
}

fn strip_v(tag: &str) -> &str {
    tag.trim().trim_start_matches('v')
}

fn build_update_info(current_version: &str, snap: ReleaseSnapshot) -> UpdateInfo {
    let (asset_name, asset_url) = match pick_asset_pair(&snap.assets) {
        Some((n, u)) => (Some(n), Some(u)),
        None => (None, None),
    };
    let update_available = match (
        semver::Version::parse(current_version),
        semver::Version::parse(&snap.latest_version),
    ) {
        (Ok(cur), Ok(latest)) => latest > cur,
        // Unparseable tags (e.g. `1.0.0.beta7`): don't nag.
        _ => false,
    };
    UpdateInfo {
        current_version: current_version.to_string(),
        latest_version: snap.latest_version,
        update_available,
        release_name: snap.release_name,
        release_url: snap.release_url,
        release_notes: snap.release_notes,
        asset_name,
        asset_url,
    }
}

fn api_status_error(status: reqwest::StatusCode, body: &str) -> NexError {
    let rate_limited = status.as_u16() == 403 || status.as_u16() == 429;
    let mentions_rate = body.contains("rate limit") || body.contains("Rate limit");
    if rate_limited && (mentions_rate || body.is_empty()) {
        return NexError::Internal(
            "查询更新失败: GitHub API 请求次数已达上限，请稍后再试".into(),
        );
    }
    if status.as_u16() == 404 {
        return NexError::Internal("查询更新失败: 未找到发布版本".into());
    }
    NexError::Internal(format!("查询更新失败: GitHub 返回 {status}"))
}

/// REST: newest non-draft release (prereleases included — `/latest` excludes them).
async fn fetch_via_api(client: &reqwest::Client) -> Result<ReleaseSnapshot, NexError> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases?per_page=10");
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| NexError::Internal(format!("查询更新失败: {e}")))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| NexError::Internal(format!("读取更新信息失败: {e}")))?;
    if !status.is_success() {
        return Err(api_status_error(status, &text));
    }
    let list: Vec<serde_json::Value> = serde_json::from_str(&text)
        .map_err(|e| NexError::Internal(format!("解析更新信息失败: {e}")))?;
    let body = list
        .into_iter()
        .find(|r| r.get("draft").and_then(|d| d.as_bool()) != Some(true))
        .ok_or_else(|| NexError::Internal("查询更新失败: 未找到发布版本".into()))?;

    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| NexError::Internal("GitHub 响应缺少 tag_name".into()))?;
    let latest_version = strip_v(tag).to_string();
    let assets = body
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let asset_pairs: Vec<(String, String)> = assets
        .iter()
        .filter_map(|a| {
            Some((
                a.get("name")?.as_str()?.to_string(),
                a.get("browser_download_url")?.as_str()?.to_string(),
            ))
        })
        .collect();

    Ok(ReleaseSnapshot {
        latest_version: latest_version.clone(),
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
        assets: asset_pairs,
    })
}

/// Extract the first Atom `<entry>` tag URL / title / content.
fn parse_atom_first_entry(atom: &str) -> Result<(String, String, String), NexError> {
    let entry = atom
        .split("<entry>")
        .nth(1)
        .and_then(|s| s.split("</entry>").next())
        .ok_or_else(|| NexError::Internal("查询更新失败: 发布源无条目".into()))?;

    let tag_url = entry
        .split("href=\"")
        .filter_map(|chunk| {
            let href = chunk.split('"').next()?;
            if href.contains("/releases/tag/") {
                Some(href.to_string())
            } else {
                None
            }
        })
        .next()
        .ok_or_else(|| NexError::Internal("查询更新失败: 发布源缺少版本链接".into()))?;

    let title = entry
        .split("<title>")
        .nth(1)
        .and_then(|s| s.split("</title>").next())
        .unwrap_or("")
        .trim()
        .to_string();

    // Content is HTML-escaped inside the feed; keep a short plain-ish preview.
    let notes = entry
        .split("<content")
        .nth(1)
        .and_then(|s| s.split('>').nth(1))
        .and_then(|s| s.split("</content>").next())
        .map(unescape_basic_xml)
        .map(|s| strip_simple_html(&s))
        .unwrap_or_default();

    Ok((tag_url, title, notes))
}

fn unescape_basic_xml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
        .replace("&#39;", "'")
}

fn strip_simple_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn tag_from_release_url(url: &str) -> Option<&str> {
    url.rsplit("/releases/tag/").next().filter(|t| !t.is_empty())
}

/// Parse `/releases/expanded_assets/{tag}` HTML for download links.
fn parse_expanded_assets(html: &str, tag: &str) -> Vec<(String, String)> {
    let needle = format!("/{GITHUB_REPO}/releases/download/{tag}/");
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(idx) = rest.find(&needle) {
        let from = &rest[idx + 1..]; // skip leading '/'
        let path = match from.split('"').next() {
            Some(p) if p.contains(&format!("releases/download/{tag}/")) => p,
            _ => {
                rest = &rest[idx + needle.len()..];
                continue;
            }
        };
        let name = path.rsplit('/').next().unwrap_or("").to_string();
        if !name.is_empty() {
            let url = format!("https://github.com/{path}");
            if !out.iter().any(|(n, _)| n == &name) {
                out.push((name, url));
            }
        }
        rest = &rest[idx + needle.len()..];
    }
    out
}

async fn fetch_via_atom(client: &reqwest::Client) -> Result<ReleaseSnapshot, NexError> {
    let atom_url = format!("https://github.com/{GITHUB_REPO}/releases.atom");
    let resp = client
        .get(&atom_url)
        .send()
        .await
        .map_err(|e| NexError::Internal(format!("查询更新失败: {e}")))?;
    if !resp.status().is_success() {
        return Err(NexError::Internal(format!(
            "查询更新失败: 发布源返回 {}",
            resp.status()
        )));
    }
    let atom = resp
        .text()
        .await
        .map_err(|e| NexError::Internal(format!("读取更新信息失败: {e}")))?;
    let (tag_url, title, notes) = parse_atom_first_entry(&atom)?;
    let tag = tag_from_release_url(&tag_url)
        .ok_or_else(|| NexError::Internal("查询更新失败: 无法解析版本号".into()))?
        .to_string();
    let latest_version = strip_v(&tag).to_string();

    let assets_url = format!("https://github.com/{GITHUB_REPO}/releases/expanded_assets/{tag}");
    let assets_resp = client
        .get(&assets_url)
        .send()
        .await
        .map_err(|e| NexError::Internal(format!("查询安装包失败: {e}")))?;
    let assets = if assets_resp.status().is_success() {
        let html = assets_resp.text().await.unwrap_or_default();
        parse_expanded_assets(&html, &tag)
    } else {
        Vec::new()
    };

    Ok(ReleaseSnapshot {
        latest_version: latest_version.clone(),
        release_name: if title.is_empty() {
            latest_version
        } else {
            title
        },
        release_url: tag_url,
        release_notes: notes,
        assets,
    })
}

/// Query GitHub for the newest release and compare against the running version.
#[tauri::command]
pub async fn update_check_latest(app: AppHandle) -> Result<UpdateInfo, NexError> {
    let current_version = app.package_info().version.to_string();

    if let Ok(guard) = CHECK_CACHE.lock() {
        if let Some(cached) = guard.as_ref() {
            if cached.at.elapsed() < CACHE_TTL && cached.info.current_version == current_version {
                return Ok(cached.info.clone());
            }
        }
    }

    let client = http_client(Some(API_TIMEOUT))?;
    let snap = match fetch_via_api(&client).await {
        Ok(s) => s,
        Err(api_err) => match fetch_via_atom(&client).await {
            Ok(s) => s,
            Err(_) => return Err(api_err),
        },
    };
    let info = build_update_info(&current_version, snap);
    if let Ok(mut guard) = CHECK_CACHE.lock() {
        *guard = Some(CachedCheck {
            at: Instant::now(),
            info: info.clone(),
        });
    }
    Ok(info)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_atom_extracts_first_release() {
        let atom = r#"<?xml version="1.0"?>
<feed>
  <entry>
    <id>tag:github.com,2008:Repository/1/v1.0.0-beta8</id>
    <link rel="alternate" type="text/html" href="https://github.com/jianjunx/nex/releases/tag/v1.0.0-beta8"/>
    <title>Nex v1.0.0-beta8</title>
    <content type="html">&lt;p&gt;notes here&lt;/p&gt;</content>
  </entry>
  <entry>
    <link rel="alternate" href="https://github.com/jianjunx/nex/releases/tag/v1.0.0"/>
    <title>old</title>
  </entry>
</feed>"#;
        let (url, title, notes) = parse_atom_first_entry(atom).unwrap();
        assert_eq!(url, "https://github.com/jianjunx/nex/releases/tag/v1.0.0-beta8");
        assert_eq!(title, "Nex v1.0.0-beta8");
        assert!(notes.contains("notes here"));
        assert_eq!(tag_from_release_url(&url), Some("v1.0.0-beta8"));
    }

    #[test]
    fn parse_expanded_assets_finds_dmg_and_exe() {
        let html = r#"
<a href="/jianjunx/nex/releases/download/v1.0.0-beta8/Nex_1.0.0_aarch64.dmg">dmg</a>
<a href="/jianjunx/nex/releases/download/v1.0.0-beta8/Nex_1.0.0_x64-setup.exe">exe</a>
"#;
        let assets = parse_expanded_assets(html, "v1.0.0-beta8");
        assert_eq!(assets.len(), 2);
        assert_eq!(assets[0].0, "Nex_1.0.0_aarch64.dmg");
        assert!(assets[0].1.starts_with("https://github.com/"));
        assert_eq!(assets[1].0, "Nex_1.0.0_x64-setup.exe");
    }

    #[test]
    fn rate_limit_error_message() {
        let err = api_status_error(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"message":"API rate limit exceeded for 1.2.3.4"}"#,
        );
        let msg = format!("{err}");
        assert!(msg.contains("请求次数已达上限"), "{msg}");
    }

    #[test]
    fn build_info_detects_newer_semver() {
        let snap = ReleaseSnapshot {
            latest_version: "1.1.0".into(),
            release_name: "Nex v1.1.0".into(),
            release_url: "https://github.com/jianjunx/nex/releases/tag/v1.1.0".into(),
            release_notes: "".into(),
            assets: vec![(
                "Nex_1.1.0_x64-setup.exe".into(),
                "https://github.com/jianjunx/nex/releases/download/v1.1.0/Nex_1.1.0_x64-setup.exe"
                    .into(),
            )],
        };
        let info = build_update_info("1.0.0", snap);
        assert!(info.update_available);
        assert_eq!(info.latest_version, "1.1.0");
    }
}
