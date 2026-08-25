use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::NexError;

/// Name of the event emitted when a git network operation needs credentials;
/// must match `EVENTS.GIT_CREDENTIAL_REQUEST` in `src/bridge/events.ts`.
pub const GIT_CREDENTIAL_REQUEST_EVENT: &str = "git-credential-request";

/// How long a GUI credential prompt may stay unanswered before the operation
/// fails (seconds). Matches the ~5-minute ceiling in the design spec.
const REQUEST_TIMEOUT_SECS: u64 = 300;

/// A user-supplied answer to a credential prompt. `secret` covers both
/// HTTPS passwords/tokens and SSH key passphrases.
#[derive(Debug, Clone)]
pub struct CredentialAnswer {
    pub username: Option<String>,
    pub secret: Option<String>,
}

/// A session-only cached credential ("remember for this session"). Never
/// persisted to disk; lives until process exit.
#[derive(Debug, Clone)]
pub struct CachedCredential {
    pub username: String,
    pub secret: String,
    pub kind: String, // "https" | "ssh-passphrase"
}

/// Payload of the `git-credential-request` event. Field names must stay
/// camelCase to match `GitCredentialRequestPayload` in `src/bridge/events.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCredentialRequestPayload {
    pub request_id: String,
    pub url: String,
    pub username_hint: Option<String>,
    pub kind: String,
}

struct PendingRequest {
    tx: tokio::sync::oneshot::Sender<Option<CredentialAnswer>>,
    url: String,
    kind: String,
}

/// In-memory credential broker: pairs git2 credential callbacks (blocked on a
/// oneshot channel inside spawn_blocking) with the GUI modal's
/// `git_credential_respond` command. Clone is cheap (Arc handles).
#[derive(Clone)]
pub struct GitCredentialBroker {
    pending: Arc<Mutex<HashMap<String, PendingRequest>>>,
    session_cache: Arc<Mutex<HashMap<String, CachedCredential>>>,
}

impl Default for GitCredentialBroker {
    fn default() -> Self {
        Self::new()
    }
}

impl GitCredentialBroker {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            session_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a pending prompt; the caller blocks on the returned receiver.
    pub fn register_pending(
        &self,
        url: &str,
        kind: &str,
    ) -> (
        String,
        tokio::sync::oneshot::Receiver<Option<CredentialAnswer>>,
    ) {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(
            request_id.clone(),
            PendingRequest {
                tx,
                url: url.to_string(),
                kind: kind.to_string(),
            },
        );
        (request_id, rx)
    }

    /// Emit the GUI request, then block the calling spawn_blocking thread
    /// until the user answers, cancels, or the timeout elapses. Must only be
    /// called from inside `tokio::task::spawn_blocking` (needs a runtime
    /// handle on the current thread).
    pub fn request_gui(
        &self,
        app: &AppHandle,
        url: &str,
        username_hint: Option<&str>,
        kind: &str,
    ) -> Result<Option<CredentialAnswer>, NexError> {
        let (request_id, rx) = self.register_pending(url, kind);
        let payload = GitCredentialRequestPayload {
            request_id: request_id.clone(),
            url: url.to_string(),
            username_hint: username_hint.map(|s| s.to_string()),
            kind: kind.to_string(),
        };
        app.emit(GIT_CREDENTIAL_REQUEST_EVENT, payload)
            .map_err(|e| NexError::Internal(format!("failed to emit credential request: {e}")))?;

        let waited = tokio::runtime::Handle::current().block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS), rx).await
        });
        self.pending.lock().unwrap().remove(&request_id);
        match waited {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(_)) => Ok(None), // sender dropped → treat as cancel
            Err(_) => Err(NexError::Git("credential request timed out".to_string())),
        }
    }

    /// Deliver a GUI answer. `username=None && secret=None` means the user
    /// cancelled. `remember=true` stores the credential in the session cache
    /// keyed by host+kind (memory only, cleared at process exit).
    pub fn respond(
        &self,
        request_id: &str,
        username: Option<String>,
        secret: Option<String>,
        remember: bool,
    ) -> Result<(), NexError> {
        let entry = self
            .pending
            .lock()
            .unwrap()
            .remove(request_id)
            .ok_or_else(|| {
                NexError::Git("no pending credential request with that id".to_string())
            })?;
        let answer = match (username.clone(), secret.clone()) {
            (None, None) => None,
            (u, s) => Some(CredentialAnswer {
                username: u,
                secret: s,
            }),
        };
        if remember {
            if let (Some(u), Some(s)) = (username, secret) {
                self.session_cache.lock().unwrap().insert(
                    session_key(&entry.url, &entry.kind),
                    CachedCredential {
                        username: u,
                        secret: s,
                        kind: entry.kind.clone(),
                    },
                );
            }
        }
        // The receiver may already be gone (timeout raced us) — that is fine.
        let _ = entry.tx.send(answer);
        Ok(())
    }

    pub fn lookup_session(&self, url: &str, kind: &str) -> Option<CachedCredential> {
        self.session_cache
            .lock()
            .unwrap()
            .get(&session_key(url, kind))
            .cloned()
    }
}

/// Cache scope: same host + same kind.
pub fn session_key(url: &str, kind: &str) -> String {
    format!("{}:{}", kind, host_of(url))
}

/// Best-effort host extraction from git remote URLs. Handles
/// `https://host/x`, `https://user@host:443/x`, `ssh://git@host:22/x`, and
/// scp-like `git@host:x/y`.
pub fn host_of(url: &str) -> String {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = after_scheme.split('/').next().unwrap_or("");
    let no_user = authority
        .rsplit_once('@')
        .map(|(_, rest)| rest)
        .unwrap_or(authority);
    no_user.split(':').next().unwrap_or(no_user).to_string()
}
