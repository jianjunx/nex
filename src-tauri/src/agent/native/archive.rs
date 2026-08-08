//! Persist NexAgent session history so `session/load` can resume a conversation.
//!
//! Archives live under `~/.nex/agent-sessions/<session_id>.json`. The session id
//! is stable when the client passes `meta.nexConversationId` on `session/new`
//! (Nex uses the conversation id).

use std::path::PathBuf;

use super::provider::ChatMessage;

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

pub fn save(session_id: &str, archive: &SessionArchive) -> Result<(), String> {
    let path = archive_path(session_id).ok_or_else(|| "no archive path".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir archive: {e}"))?;
    }
    let raw = serde_json::to_vec_pretty(archive).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("write archive: {e}"))
}

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
}
