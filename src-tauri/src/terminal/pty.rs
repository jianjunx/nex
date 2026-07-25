use crate::error::NexError;
use crate::terminal::types::TerminalOutputPayload;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/// Name of the event emitted with PTY output; must match
/// `EVENTS.TERMINAL_OUTPUT` in `src/bridge/events.ts`.
const TERMINAL_OUTPUT_EVENT: &str = "terminal-output";

pub struct TerminalSession {
    pub id: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

pub struct TerminalManager {
    sessions: Arc<Mutex<Vec<Arc<TerminalSession>>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self { sessions: Arc::new(Mutex::new(Vec::new())) }
    }

    pub fn create(&self, app: AppHandle, cwd: &str, shell: Option<&str>) -> Result<String, NexError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| NexError::Terminal(e.to_string()))?;

        // No explicit shell: use the platform default login shell
        // ($SHELL/passwd on unix, %ComSpec%/cmd.exe on Windows).
        let mut cmd = match shell {
            Some(shell) => CommandBuilder::new(shell),
            None => CommandBuilder::new_default_prog(),
        };
        cmd.cwd(cwd);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| NexError::Terminal(e.to_string()))?;

        let master = pair.master;
        let mut reader = master
            .try_clone_reader()
            .map_err(|e| NexError::Terminal(e.to_string()))?;
        let writer = master
            .take_writer()
            .map_err(|e| NexError::Terminal(e.to_string()))?;

        let id = Uuid::new_v4().to_string();

        // Reader thread: forwards PTY output to the frontend until the child
        // exits (EOF / read error), at which point the thread ends.
        let app_clone = app.clone();
        let sid = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let payload = TerminalOutputPayload {
                            terminal_id: sid.clone(),
                            data: String::from_utf8_lossy(&buf[..n]).to_string(),
                        };
                        let _ = app_clone.emit(TERMINAL_OUTPUT_EVENT, payload);
                    }
                    Err(_) => break,
                }
            }
        });

        let session = Arc::new(TerminalSession {
            id: id.clone(),
            master: Mutex::new(master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
        });

        self.sessions.lock().unwrap().push(session);
        Ok(id)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), NexError> {
        let session = self.session(id)?;
        session
            .writer
            .lock()
            .unwrap()
            .write_all(data.as_bytes())
            .map_err(|e| NexError::Terminal(e.to_string()))?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), NexError> {
        let session = self.session(id)?;
        session
            .master
            .lock()
            .unwrap()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| NexError::Terminal(e.to_string()))?;
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), NexError> {
        // Remove the session from the vec and drop the vec lock before
        // killing the child, so a stalled kill can't block create/kill/
        // resize for every other terminal.
        let session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.iter().position(|s| s.id == id).map(|pos| sessions.remove(pos))
        };
        if let Some(session) = session {
            // Terminate the child so the shell process isn't leaked; the
            // reader thread then sees EOF on the PTY and exits on its own.
            // Ignore errors - the child may already have exited.
            let _ = session.child.lock().unwrap().kill();
        }
        Ok(())
    }

    /// Looks up a session by id and clones its `Arc`, dropping the sessions
    /// vec lock before the caller does any PTY I/O (a stalled child with a
    /// full pipe must not block the other terminals). Mirrors
    /// `AcpSessionManager::session`.
    fn session(&self, id: &str) -> Result<Arc<TerminalSession>, NexError> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| NexError::Terminal("session not found".into()))
    }
}
