//! Session-level working memory.
//!
//! Holds the bits of "current task state" the model actually needs in
//! scope while reasoning. The current implementation is **system-driven**:
//! the harness updates the memory after key events (file change, tool
//! error, task shape change) and the model cannot rewrite the block
//! directly. This is deliberate — letting the model free-form rewrite a
//! block destroys prefix-cache stability and opens a prompt-injection
//! surface against the summarisation path.
//!
//! The rendered memory is a * `assistant`* block so it cannot be mistaken
//! for system instructions, matching the same trust floor as the summary
//! splice.

use serde::{Deserialize, Serialize};

/// Hard field cap. Beyond this the memory block itself becomes the
/// transcript-bloat problem we are trying to solve.
pub const MEMORY_TOTAL_BYTES: usize = 8 * 1024;

/// Soft cap per individual list field. Keeps the rendered block scannable.
const MAX_LIST_ITEMS: usize = 16;
const MAX_NOTES_BYTES: usize = 1024;

/// Why the memory block was last updated. Used as a fingerprint so the
/// turn loop only re-renders the block when something actually changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemoryTrigger {
    SessionStarted,
    FileChanged,
    ToolError,
    GoalUpdated,
}

/// Structured memory state for one session. All fields are append-only-ish:
/// the harness merges into them; no field ever grows unbounded.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkingMemory {
    /// Highest-priority slot: what the session is trying to accomplish.
    /// One short sentence is enough; we don't restate the user prompt.
    pub goal: Vec<String>,
    /// Files inspected this session (no contents — the model can re-read).
    pub files_inspected: Vec<String>,
    /// Files the session actually modified.
    pub files_changed: Vec<String>,
    /// Open questions the model is actively tracking.
    pub open_questions: Vec<String>,
    /// Free-text "soft state" — for things the schema cannot express
    /// (user-claimed constraints, partial hypotheses, debugging context).
    /// Kept short on purpose; the block is for live reasoning, not for
    /// archiving everything.
    pub state_notes: String,
    /// Schema version so future migrations can detect the on-disk shape.
    pub version: u32,
}

impl WorkingMemory {
    /// Bump the schema version when changing the serialised layout.
    pub const VERSION: u32 = 1;

    pub fn new() -> Self {
        Self {
            version: Self::VERSION,
            ..Default::default()
        }
    }

    /// Idempotent push: ignore duplicates, honour the per-field cap.
    pub fn record_file_inspected(&mut self, path: impl Into<String>) {
        push_unique(&mut self.files_inspected, path.into());
    }

    pub fn record_file_changed(&mut self, path: impl Into<String>) {
        let path = path.into();
        push_unique(&mut self.files_changed, path.clone());
        push_unique(&mut self.files_inspected, path);
    }

    pub fn record_open_question(&mut self, q: impl Into<String>) {
        push_unique(&mut self.open_questions, q.into());
    }

    pub fn record_tool_error(&mut self, summary: impl Into<String>) {
        push_unique(&mut self.open_questions, format!("tool error: {}", summary.into()));
    }

    pub fn set_goal(&mut self, goal: impl Into<String>) {
        self.goal.clear();
        self.goal.push(goal.into());
    }

    /// Append to `state_notes`. Trims the oldest content if the cap is
    /// reached so we never grow the block unbounded.
    pub fn append_note(&mut self, note: impl AsRef<str>) {
        let note = note.as_ref().to_string();
        if self.state_notes.is_empty() {
            self.state_notes = note;
        } else {
            self.state_notes.push('\n');
            self.state_notes.push_str(&note);
        }
        if self.state_notes.len() > MAX_NOTES_BYTES {
            let start = self.state_notes.len() - MAX_NOTES_BYTES;
            // Drop on a UTF-8 char boundary so we never slice a code point.
            let cut = self.state_notes[start..]
                .char_indices()
                .next()
                .map(|(i, _)| start + i)
                .unwrap_or(start);
            self.state_notes = self.state_notes[cut..].to_string();
        }
    }
}

fn push_unique(v: &mut Vec<String>, item: String) {
    if v.iter().any(|x| x == &item) {
        return;
    }
    v.push(item);
    if v.len() > MAX_LIST_ITEMS {
        let drop = v.len() - MAX_LIST_ITEMS;
        v.drain(..drop);
    }
}

/// Render the memory block to be spliced into the live transcript as a
/// stable assistant message. The format is byte-stable across turns so it
/// doesn't perturb the provider's prefix cache unless the content
/// actually changed.
pub fn render(memory: &WorkingMemory) -> String {
    let mut s = String::with_capacity(512);
    s.push_str("[nex:working-memory]\n");
    if !memory.goal.is_empty() {
        s.push_str("Goal:\n");
        for g in &memory.goal {
            s.push_str(&format!("- {g}\n"));
        }
    }
    if !memory.files_changed.is_empty() {
        s.push_str("Changed files:\n");
        for f in &memory.files_changed {
            s.push_str(&format!("- {f}\n"));
        }
    }
    if !memory.files_inspected.is_empty() {
        s.push_str("Inspected files:\n");
        for f in &memory.files_inspected {
            s.push_str(&format!("- {f}\n"));
        }
    }
    if !memory.open_questions.is_empty() {
        s.push_str("Open questions:\n");
        for q in &memory.open_questions {
            s.push_str(&format!("- {q}\n"));
        }
    }
    if !memory.state_notes.is_empty() {
        s.push_str("State notes:\n");
        s.push_str(memory.state_notes.trim_end());
        s.push('\n');
    }
    s.push_str(&format!(
        "[memory updated; do not re-render unless a hook updates this block]\n"
    ));
    s
}

/// One rendered memory block plus the trigger that produced it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedMemory {
    pub text: String,
    pub trigger: MemoryTrigger,
}

impl RenderedMemory {
    pub fn new(memory: &WorkingMemory, trigger: MemoryTrigger) -> Self {
        Self {
            text: render(memory),
            trigger,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_is_stable_for_identical_state() {
        let mut m = WorkingMemory::new();
        m.set_goal("ship v1");
        m.record_file_changed("src/main.rs");
        m.record_file_inspected("src/main.rs");
        m.record_open_question("verify cache");
        m.append_note("user said ignore linter warnings for now");
        let r1 = render(&m);
        let r2 = render(&m);
        assert_eq!(r1, r2);
    }

    #[test]
    fn render_dedupes_files() {
        let mut m = WorkingMemory::new();
        m.record_file_changed("a.rs");
        m.record_file_changed("a.rs");
        m.record_file_changed("b.rs");
        assert_eq!(m.files_changed, vec!["a.rs", "b.rs"]);
    }

    #[test]
    fn notes_truncate_to_cap() {
        let mut m = WorkingMemory::new();
        m.append_note("a".repeat(MAX_NOTES_BYTES + 200));
        assert!(m.state_notes.len() <= MAX_NOTES_BYTES);
        // The truncation keeps the tail and slices on a char boundary.
        assert!(m.state_notes.ends_with(&"a".repeat(64)));
    }

    #[test]
    fn render_triggers_are_distinct() {
        let mut m = WorkingMemory::new();
        m.set_goal("x");
        let a = RenderedMemory::new(&m, MemoryTrigger::SessionStarted);
        let b = RenderedMemory::new(&m, MemoryTrigger::GoalUpdated);
        assert_ne!(a.trigger, b.trigger);
        assert_eq!(a.text, b.text); // content identical, trigger differs
    }
}