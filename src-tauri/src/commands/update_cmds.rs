//! GitHub-release based update channel.
//!
//! The app has no updater signing infrastructure, so this is a lightweight
//! flow: query the latest published GitHub release, compare semver, download
//! the platform installer asset with progress events, then replace the running
//! app. Windows waits for this process to exit, then launches NSIS via a
//! breakaway helper script (must survive Tauri's job object on parent exit).
//! macOS waits, copies the `.app` out of the `.dmg` over the running bundle,
//! and relaunches — Finder drag-install is only a fallback when not running from
//! a bundle (e.g. `tauri dev`).
//!
//! Unauthenticated clients share a 60 req/h IP quota on `api.github.com`
//! (easy to exhaust on a NAT). We query REST `/releases?per_page=N` first
//! (includes prereleases; `/latest` does not), then fall back to the Atom
//! feed + `expanded_assets` HTML on 403/429/network failure. Successful
//! results are cached in-process for a few minutes.

use serde::Serialize;
use std::path::Path;
#[cfg(any(target_os = "macos", test))]
use std::path::PathBuf;
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

/// POSIX single-quote a path for embedding in a `/bin/bash` script.
#[cfg(any(target_os = "macos", test))]
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `/Applications/Nex.app/Contents/MacOS/nex` → `/Applications/Nex.app`.
/// Plain `target/debug/nex` (dev) returns `None` so we don't overwrite a random folder.
#[cfg(any(target_os = "macos", test))]
fn macos_bundle_from_exe(exe: &Path) -> Option<PathBuf> {
    let macos_dir = exe.parent()?;
    if macos_dir.file_name()?.to_str() != Some("MacOS") {
        return None;
    }
    let contents = macos_dir.parent()?;
    if contents.file_name()?.to_str() != Some("Contents") {
        return None;
    }
    let app = contents.parent()?;
    if app.extension()?.to_str() != Some("app") {
        return None;
    }
    Some(app.to_path_buf())
}

/// Helper script: wait for `pid` to die, then ditto the `.app` out of the dmg
/// onto `dest` and `open` it. Paths are quoted; the script lives next to the dmg.
#[cfg(any(target_os = "macos", test))]
fn macos_relaunch_script(pid: u32, dmg: &Path, dest: &Path, log: &Path, mnt: &Path) -> String {
    let dmg_q = shell_single_quote(&dmg.to_string_lossy());
    let dest_q = shell_single_quote(&dest.to_string_lossy());
    let log_q = shell_single_quote(&log.to_string_lossy());
    let mnt_q = shell_single_quote(&mnt.to_string_lossy());
    format!(
        r#"#!/bin/bash
set -u
PID={pid}
DMG={dmg_q}
DEST={dest_q}
MNT={mnt_q}
BACKUP="${{DEST}}.nex-update-bak"
exec >>{log_q} 2>&1
echo "nex update start $(date) pid=$PID"

n=0
while /bin/kill -0 "$PID" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 150 ]; then
    echo "timeout waiting for pid $PID"
    break
  fi
  /bin/sleep 0.2
done
/bin/sleep 0.5

cleanup() {{
  /usr/bin/hdiutil detach "$MNT" -force -quiet 2>/dev/null || true
  /bin/rmdir "$MNT" 2>/dev/null || true
}}
trap cleanup EXIT

/bin/mkdir -p "$MNT"
if ! /usr/bin/hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG"; then
  echo "hdiutil attach failed"
  /usr/bin/open "$DEST" 2>/dev/null || true
  exit 1
fi

SRC=$(/usr/bin/find "$MNT" -maxdepth 1 -name '*.app' -print | /usr/bin/head -n 1)
if [ -z "${{SRC:-}}" ] || [ ! -d "$SRC" ]; then
  echo "no .app in dmg"
  /usr/bin/open "$DEST" 2>/dev/null || true
  exit 1
fi
src_base=$(/usr/bin/basename "$SRC")
dst_base=$(/usr/bin/basename "$DEST")
if [ "$src_base" != "$dst_base" ]; then
  echo "app name mismatch $src_base vs $dst_base"
  /usr/bin/open "$DEST" 2>/dev/null || true
  exit 1
fi

/bin/rm -rf "$BACKUP"
if ! /bin/mv "$DEST" "$BACKUP"; then
  echo "could not move running bundle aside"
  /usr/bin/open "$DEST" 2>/dev/null || true
  exit 1
fi
if ! /usr/bin/ditto "$SRC" "$DEST"; then
  echo "ditto failed, restoring"
  /bin/rm -rf "$DEST"
  /bin/mv "$BACKUP" "$DEST"
  /usr/bin/open "$DEST" 2>/dev/null || true
  exit 1
fi
/bin/rm -rf "$BACKUP"
/usr/bin/xattr -cr "$DEST" 2>/dev/null || true
/usr/bin/open "$DEST"
echo "nex update done $(date)"
"#
    )
}

/// PowerShell helper script: wait until Nex exits, then launch the NSIS installer.
/// Writes to `$Log` so a silent failure is diagnosable under
/// `%APPDATA%\\com.nex.app\\updater\\install-and-relaunch.log`.
#[cfg(any(target_os = "windows", test))]
fn windows_install_script(pid: u32, installer: &Path, log: &Path) -> String {
    let installer_q = installer.to_string_lossy().replace('\'', "''");
    let log_q = log.to_string_lossy().replace('\'', "''");
    format!(
        r#"$ErrorActionPreference = 'Stop'
$NexPid = {pid}
$Installer = '{installer_q}'
$Log = '{log_q}'
function Write-Log([string]$Message) {{
  "$(Get-Date -Format o) $Message" | Add-Content -LiteralPath $Log -Encoding UTF8
}}
try {{
  Write-Log "nex update helper start pid=$PID nexPid=$NexPid"
  $n = 0
  while ($n -lt 300) {{
    if (-not (Get-Process -Id $NexPid -ErrorAction SilentlyContinue)) {{ break }}
    $n++
    Start-Sleep -Milliseconds 200
  }}
  if ($n -ge 300) {{
    Write-Log "timeout waiting for nex pid=$NexPid; launching installer anyway"
  }}
  Start-Sleep -Milliseconds 800
  if (-not (Test-Path -LiteralPath $Installer)) {{
    Write-Log "installer missing: $Installer"
    exit 1
  }}
  $proc = Start-Process -LiteralPath $Installer -PassThru
  Write-Log "installer started pid=$($proc.Id) path=$Installer"
}} catch {{
  Write-Log "error: $_"
  exit 1
}}
"#
    )
}

/// Strip a release tag down to a bare semver for comparison. Published tags
/// vary between `release-v1.2.3`, `v1.2.3` and `1.2.3` (prerelease/build
/// suffixes like `-beta.1` are kept, `release-v` is normalized away).
fn strip_v(tag: &str) -> &str {
    let trimmed = tag.trim();
    let without_release = trimmed.strip_prefix("release-").unwrap_or(trimmed);
    without_release.strip_prefix('v').unwrap_or(without_release)
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
/// then replace the running app. Windows/macOS both wait for this process to
/// exit so the installer can overwrite files; macOS copies the bundle from
/// the dmg and relaunches. Finder drag-install is only used when we are not
/// running from a `.app` (dev builds).
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
    // Release the download handle before launching: a still-open file
    // (or an AV real-time scan of the freshly-written exe) blocks the
    // installer from opening it — os error 32 (sharing violation).
    drop(file);

    launch_downloaded_installer(&app, &dest)
}

#[cfg(target_os = "windows")]
fn spawn_windows_installer(dest: &Path) -> Result<(), NexError> {
    let dir = dest
        .parent()
        .ok_or_else(|| NexError::Internal("更新目录无效".into()))?;
    let script_path = dir.join("install-and-relaunch.ps1");
    let log_path = dir.join("install-and-relaunch.log");
    let script = windows_install_script(std::process::id(), dest, &log_path);
    std::fs::write(&script_path, script)
        .map_err(|e| NexError::Internal(format!("写入更新脚本失败: {e}")))?;

    let script_arg = script_path.to_string_lossy().into_owned();

    fn spawn_helper(script_arg: &str, breakaway: bool) -> std::io::Result<std::process::Child> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let mut flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS;
        if breakaway {
            flags |= CREATE_BREAKAWAY_FROM_JOB;
        }
        // `cmd /C start` returns immediately; the helper outlives Nex.
        std::process::Command::new("cmd")
            .args([
                "/C",
                "start",
                "",
                "/min",
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
                script_arg,
            ])
            .creation_flags(flags)
            .spawn()
    }

    match spawn_helper(&script_arg, true) {
        Ok(_) => Ok(()),
        Err(e) if e.raw_os_error() == Some(5) => spawn_helper(&script_arg, false)
            .map(|_| ())
            .map_err(|e2| {
                NexError::Internal(format!(
                    "启动安装程序失败: {e2}（breakaway 被拒绝: {e}）"
                ))
            }),
        Err(e) => Err(NexError::Internal(format!("启动安装程序失败: {e}"))),
    }
}

/// Returns true when a helper was spawned and the app should exit.
#[cfg(target_os = "macos")]
fn spawn_macos_bundle_replace(dmg: &Path) -> Result<bool, NexError> {
    let Some(dest) = std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(macos_bundle_from_exe)
    else {
        return Ok(false);
    };

    let dir = dmg
        .parent()
        .ok_or_else(|| NexError::Internal("更新目录无效".into()))?;
    let script_path = dir.join("install-and-relaunch.sh");
    let log_path = dir.join("install-and-relaunch.log");
    let mnt = std::env::temp_dir().join(format!("nex-update-mnt-{}", std::process::id()));
    let script = macos_relaunch_script(std::process::id(), dmg, &dest, &log_path, &mnt);
    std::fs::write(&script_path, script)
        .map_err(|e| NexError::Internal(format!("写入更新脚本失败: {e}")))?;
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path)
            .map_err(|e| NexError::Internal(format!("读取更新脚本权限失败: {e}")))?
            .permissions();
        perms.set_mode(0o700);
        std::fs::set_permissions(&script_path, perms)
            .map_err(|e| NexError::Internal(format!("设置更新脚本权限失败: {e}")))?;
    }

    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    std::process::Command::new("/bin/bash")
        .arg(&script_path)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| NexError::Internal(format!("启动更新程序失败: {e}")))?;
    Ok(true)
}

fn launch_downloaded_installer(app: &AppHandle, dest: &Path) -> Result<(), NexError> {
    #[cfg(target_os = "windows")]
    {
        spawn_windows_installer(dest)?;
        app.exit(0);
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        if spawn_macos_bundle_replace(dest)? {
            app.exit(0);
            return Ok(());
        }
        // Dev / unpackaged: fall back to opening the dmg.
        std::process::Command::new("open")
            .arg(dest)
            .spawn()
            .map_err(|e| NexError::Internal(format!("打开安装镜像失败: {e}")))?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = (app, dest);
        Ok(())
    }
}

/// Open an http(s) URL in the system browser (terminal links, About, etc.).
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), NexError> {
    if !is_browser_safe_url(&url) {
        return Err(NexError::Internal("仅允许打开 http(s) 链接".into()));
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
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| NexError::Internal(format!("打开浏览器失败: {e}")))?;
    }
    Ok(())
}

fn is_browser_safe_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control() || c == ' ') {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && !lower.starts_with("https://.")
        && !lower.starts_with("http://.")
}

#[cfg(test)]
mod open_external_tests {
    use super::is_browser_safe_url;

    #[test]
    fn accepts_http_https_rejects_other() {
        assert!(is_browser_safe_url("https://github.com/jianjunx/nex"));
        assert!(is_browser_safe_url("http://example.com/a?b=1"));
        assert!(!is_browser_safe_url("javascript:alert(1)"));
        assert!(!is_browser_safe_url("file:///etc/passwd"));
        assert!(!is_browser_safe_url("https://evil.com\nhttps://good.com"));
    }
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
    fn strip_v_normalizes_all_published_tag_formats() {
        // CI publishes `release-vX.Y.Z`; manual/older releases may use `v` or bare.
        assert_eq!(strip_v("release-v1.2.3"), "1.2.3");
        assert_eq!(strip_v("v1.2.3"), "1.2.3");
        assert_eq!(strip_v("1.2.3"), "1.2.3");
        // Prerelease/build suffixes survive.
        assert_eq!(strip_v("release-v1.0.0-beta8"), "1.0.0-beta8");
        assert_eq!(strip_v("v1.2.3+build.5"), "1.2.3+build.5");
        assert_eq!(strip_v("  release-v2.0.0  "), "2.0.0");
    }

    #[test]
    fn macos_bundle_from_standard_layout() {
        let exe = PathBuf::from("/Applications/Nex.app/Contents/MacOS/nex");
        assert_eq!(
            macos_bundle_from_exe(&exe),
            Some(PathBuf::from("/Applications/Nex.app"))
        );
        assert!(macos_bundle_from_exe(Path::new("/Users/jj/nex/target/debug/nex")).is_none());
        assert!(macos_bundle_from_exe(Path::new("/Applications/Nex.app/Contents/MacOS")).is_none());
    }

    #[test]
    fn shell_single_quote_escapes_apostrophe() {
        assert_eq!(shell_single_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_single_quote("/tmp/Nex 1.dmg"), "'/tmp/Nex 1.dmg'");
    }

    #[test]
    fn macos_script_waits_then_replaces_quoted_paths() {
        let script = macos_relaunch_script(
            42,
            Path::new("/tmp/Nex 1.dmg"),
            Path::new("/Applications/Nex.app"),
            Path::new("/tmp/log"),
            Path::new("/tmp/mnt"),
        );
        assert!(script.contains("PID=42"));
        assert!(script.contains("'/tmp/Nex 1.dmg'"));
        assert!(script.contains("'/Applications/Nex.app'"));
        assert!(script.contains("while /bin/kill -0 \"$PID\""));
        assert!(script.contains("/usr/bin/ditto"));
        assert!(script.contains("/usr/bin/open"));
        assert!(script.contains("nex-update-bak"));
    }

    #[test]
    fn windows_script_waits_polls_and_logs() {
        let script = windows_install_script(
            42,
            Path::new(r"C:\Users\O'Brien\Nex-setup.exe"),
            Path::new(r"C:\Users\O'Brien\AppData\Roaming\com.nex.app\updater\install.log"),
        );
        assert!(script.contains("$NexPid = 42"));
        assert!(script.contains(r"C:\Users\O''Brien\Nex-setup.exe"));
        assert!(script.contains("Get-Process -Id $NexPid"));
        assert!(script.contains("Start-Process -LiteralPath $Installer"));
        assert!(script.contains("Write-Log"));
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
