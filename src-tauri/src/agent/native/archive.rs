//! Persist NexAgent session history so `session/load` can resume a conversation.
//!
//! Archives live under `~/.nex/agent-sessions/<session_id>.json`. The session id
//! is stable when the client passes `meta.nexConversationId` on `session/new`
//! (Nex uses the conversation id).

use std::io::Write;
use std::path::{Path, PathBuf};

use super::provider::{ChatMessage, Content, ContentPart};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionArchive {
    pub cwd: PathBuf,
    pub model_id: String,
    pub mode_id: String,
    pub history: Vec<ChatMessage>,
}

fn archive_dir() -> Option<PathBuf> {
    super::home::nex_home().map(|h| h.join("agent-sessions"))
}

pub fn archive_path(session_id: &str) -> Option<PathBuf> {
    let safe = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe.is_empty() {
        return None;
    }
    archive_dir().map(|d| d.join(format!("{safe}.json")))
}

/// Drop `image_url` parts (and empty multimodal shells) so archives stay small.
pub fn history_without_images(history: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut copy = history.to_vec();
    strip_images_in_place(&mut copy);
    copy
}

/// Remove inline image data from a live transcript once its turn has finished.
/// Images exist briefly to make the vision request, but retaining data-URI
/// base64 in later requests turns one attachment into permanent session-memory
/// growth. The marker preserves meaning for an image-only prompt.
pub fn strip_images_in_place(history: &mut [ChatMessage]) {
    for msg in history {
        let Some(Content::Parts(parts)) = &msg.content else {
            continue;
        };
        let removed = parts.iter().filter(|p| p.typ == "image_url").count();
        if removed == 0 {
            continue;
        }
        let kept: Vec<ContentPart> = parts
            .iter()
            .filter(|p| p.typ != "image_url")
            .cloned()
            .collect();
        msg.content = match kept.as_slice() {
            [] => Some(Content::Text(format!(
                "[图片附件 ×{removed} 已在本轮发送；原始图片不会保留在会话历史中]"
            ))),
            [only] if only.typ == "text" => {
                Some(Content::Text(only.text.clone().unwrap_or_default()))
            }
            _ => Some(Content::Parts(kept)),
        };
    }
}

pub fn save(session_id: &str, archive: &SessionArchive) -> Result<(), String> {
    let path = archive_path(session_id).ok_or_else(|| "no archive path".to_string())?;
    save_at(&path, archive)
}

/// Writes an archive through a same-directory temporary file, then atomically
/// replaces the old version. Keeping the temporary beside the destination is
/// essential: cross-directory rename can degrade into copy/delete semantics.
fn save_at(path: &Path, archive: &SessionArchive) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir archive: {e}"))?;
    }
    let raw = serde_json::to_vec_pretty(archive).map_err(|e| e.to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "archive has no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "archive has no valid file name".to_string())?;
    // Unique names ensure concurrent prompt persistence attempts cannot race
    // by clobbering one shared `.tmp` file.
    let tmp = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)
            .map_err(|e| format!("create archive tmp: {e}"))?;
        file.write_all(&raw)
            .map_err(|e| format!("write archive tmp: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("sync archive tmp: {e}"))?;
    }
    atomic_replace(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replace archive: {e}")
    })?;
    sync_parent_dir(parent);
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(tmp: &Path, path: &Path) -> std::io::Result<()> {
    // POSIX rename atomically replaces an existing destination; importantly,
    // never delete `path` first.
    std::fs::rename(tmp, path)
}

#[cfg(windows)]
fn atomic_replace(tmp: &Path, path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    // MoveFileExW with REPLACE_EXISTING performs a same-volume replacement
    // without the old `remove_file` window. WRITE_THROUGH asks Windows to
    // flush the move before returning.
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            lp_existing_file_name: *const u16,
            lp_new_file_name: *const u16,
            dw_flags: u32,
        ) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let src: Vec<u16> = tmp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let dst: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(),
            dst.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_dir(parent: &Path) {
    if let Ok(dir) = std::fs::File::open(parent) {
        if let Err(e) = dir.sync_all() {
            log::warn!("archive directory sync failed for {}: {e}", parent.display());
        }
    }
}

#[cfg(not(unix))]
fn sync_parent_dir(_parent: &Path) {}

pub fn load(session_id: &str) -> Option<SessionArchive> {
    let path = archive_path(session_id)?;
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

pub fn exists(session_id: &str) -> bool {
    archive_path(session_id)
        .map(|p| p.is_file())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native::provider::{ContentPart, ImageUrl};

    #[test]
    fn save_load_roundtrip() {
        // Archives live under `~/.nex/agent-sessions`. Skip when home cannot
        // be resolved (CI / sandboxed runners) so the suite stays green.
        let id = format!("test-sess-{}", uuid::Uuid::new_v4());
        let Some(path) = archive_path(&id) else {
            return;
        };
        let arch = SessionArchive {
            cwd: PathBuf::from("/tmp/proj"),
            model_id: "deepseek/deepseek-chat".into(),
            mode_id: "code".into(),
            history: vec![ChatMessage::system("hi")],
        };
        if let Err(e) = save(&id, &arch) {
            // Permission / filesystem issues — skip rather than flake.
            eprintln!("skipping archive roundtrip: {e}");
            return;
        }
        let Some(loaded) = load(&id) else {
            let _ = std::fs::remove_file(&path);
            panic!("load after save returned None");
        };
        assert_eq!(loaded.model_id, arch.model_id);
        assert_eq!(loaded.history.len(), 1);
        assert!(exists(&id));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn history_without_images_strips_image_parts() {
        let mut msg = ChatMessage::user("see this");
        msg.content = Some(Content::Parts(vec![
            ContentPart::text("see this"),
            ContentPart {
                typ: "image_url".into(),
                text: None,
                image_url: Some(ImageUrl {
                    url: "data:image/png;base64,AAAA".into(),
                }),
            },
        ]));
        let stripped = history_without_images(&[msg]);
        match &stripped[0].content {
            Some(Content::Text(t)) => assert_eq!(t, "see this"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn strip_images_in_place_releases_image_only_turns() {
        let mut history = vec![ChatMessage {
            role: "user".into(),
            content: Some(Content::Parts(vec![ContentPart {
                typ: "image_url".into(),
                text: None,
                image_url: Some(ImageUrl {
                    url: "data:image/png;base64,VERY-LARGE-PAYLOAD".into(),
                }),
            }])),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        }];
        strip_images_in_place(&mut history);
        let text = history[0].content.as_ref().and_then(Content::as_text).unwrap();
        assert!(text.contains("不会保留"));
        assert!(!text.contains("VERY-LARGE-PAYLOAD"));
    }

    #[test]
    fn save_at_replaces_existing_archive_without_shared_temp_name() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("session.json");
        let first = SessionArchive {
            cwd: PathBuf::from("/tmp/one"),
            model_id: "model-a".into(),
            mode_id: "code".into(),
            history: vec![ChatMessage::system("first")],
        };
        let second = SessionArchive {
            cwd: PathBuf::from("/tmp/two"),
            model_id: "model-b".into(),
            mode_id: "ask".into(),
            history: vec![ChatMessage::system("second")],
        };
        save_at(&path, &first).unwrap();
        save_at(&path, &second).unwrap();
        let loaded: SessionArchive = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(loaded.model_id, "model-b");
        assert_eq!(loaded.cwd, PathBuf::from("/tmp/two"));
        assert!(std::fs::read_dir(tmp.path())
            .unwrap()
            .all(|entry| !entry.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }
}
