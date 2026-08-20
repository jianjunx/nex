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

/// Marker prefix for the spliced assistant memory block. Compact / summary
/// must never fold or replace a message that starts with this.
pub const MARKER: &str = "[nex:working-memory]";

/// First-session placeholder goal. Replaced by the first real user prompt.
pub const PLACEHOLDER_GOAL: &str = "理解用户的目标并开始工作";

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

/// Structured memory state for one session. Current-task fields are replaced
/// when the harness detects a strong task pivot; bounded history is kept only
/// to help later diagnosis explain where context diverged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkingMemory {
    /// Highest-priority slot: what the session is trying to accomplish.
    /// One short sentence is enough; we don't restate the user prompt.
    pub goal: Vec<String>,
    /// Optional page/object anchor for the active task (for example
    /// `SettlementRelation/index`). Helps the harness tell same-domain task
    /// pivots from same-target elaboration.
    #[serde(default)]
    pub task_anchor: Option<String>,
    /// Files inspected for the active task (no contents — the model can re-read).
    pub files_inspected: Vec<String>,
    /// Files the session actually modified.
    pub files_changed: Vec<String>,
    /// Open questions the model is actively tracking for the active task.
    pub open_questions: Vec<String>,
    /// The current todo list supplied by `todo_write`. Unlike ad-hoc open
    /// questions, that tool replaces the entire list, so completed/cancelled
    /// work can disappear instead of accumulating forever.
    #[serde(default)]
    pub active_todos: Vec<String>,
    /// Free-text "soft state" — for things the schema cannot express
    /// (user-claimed constraints, partial hypotheses, debugging context).
    /// Kept short on purpose; the block is for live reasoning, not for
    /// archiving everything.
    pub state_notes: String,
    /// Bounded task-transition breadcrumbs. These are diagnostic-only: the
    /// model should use them to explain why a thread drifted, not to treat old
    /// tasks as still active instructions.
    #[serde(default)]
    pub recent_task_switches: Vec<String>,
    /// Schema version so future migrations can detect the on-disk shape.
    pub version: u32,
}

impl Default for WorkingMemory {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkingMemory {
    /// Bump the schema version when changing the serialised layout.
    pub const VERSION: u32 = 3;

    pub fn new() -> Self {
        Self {
            goal: Vec::new(),
            task_anchor: None,
            files_inspected: Vec::new(),
            files_changed: Vec::new(),
            open_questions: Vec::new(),
            active_todos: Vec::new(),
            state_notes: String::new(),
            recent_task_switches: Vec::new(),
            version: Self::VERSION,
        }
    }

    /// Best-effort parse from the rendered assistant memory block. Returns
    /// `None` when the text is not a memory block or is obviously malformed.
    pub fn parse_rendered(text: &str) -> Option<Self> {
        if !text.starts_with(MARKER) {
            return None;
        }
        let mut memory = WorkingMemory::new();
        let mut section: Option<&str> = None;
        for raw in text.lines().skip(1) {
            let line = raw.trim_end();
            if line.is_empty() {
                continue;
            }
            if line == "Goal:" {
                section = Some("goal");
                continue;
            }
            if line == "Task anchor:" {
                section = Some("anchor");
                continue;
            }
            if line == "Changed files:" {
                section = Some("changed");
                continue;
            }
            if line == "Inspected files:" {
                section = Some("inspected");
                continue;
            }
            if line == "Open questions:" {
                section = Some("open");
                continue;
            }
            if line == "Open tasks:" {
                section = Some("todos");
                continue;
            }
            if line == "State notes:" {
                section = Some("notes");
                continue;
            }
            if line == "Recent task switches:" {
                section = Some("switches");
                continue;
            }
            if line.starts_with("[memory updated") {
                break;
            }
            match section {
                Some("goal") if line.starts_with("- ") => memory.goal.push(line[2..].to_string()),
                Some("anchor") if line.starts_with("- ") => {
                    memory.task_anchor = Some(line[2..].to_string())
                }
                Some("changed") if line.starts_with("- ") => {
                    memory.files_changed.push(line[2..].to_string())
                }
                Some("inspected") if line.starts_with("- ") => {
                    memory.files_inspected.push(line[2..].to_string())
                }
                Some("open") if line.starts_with("- ") => {
                    memory.open_questions.push(line[2..].to_string())
                }
                Some("todos") if line.starts_with("- ") => {
                    memory.active_todos.push(line[2..].to_string())
                }
                Some("notes") => {
                    if memory.state_notes.is_empty() {
                        memory.state_notes.push_str(line);
                    } else {
                        memory.state_notes.push('\n');
                        memory.state_notes.push_str(line);
                    }
                }
                Some("switches") if line.starts_with("- ") => {
                    memory.recent_task_switches.push(line[2..].to_string())
                }
                _ => {}
            }
        }
        Some(memory)
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
        push_unique(
            &mut self.open_questions,
            format!("tool error: {}", summary.into()),
        );
    }

    /// A successful retry of a tool resolves its prior error reminders. Keep
    /// errors from other tools: they may still need attention.
    pub fn resolve_tool_errors(&mut self, tool_name: &str) {
        let prefix = format!("tool error: {tool_name}:");
        self.open_questions
            .retain(|question| !question.starts_with(&prefix));
    }

    /// Replaces the todo-derived portion of memory. `todo_write` is a full
    /// snapshot rather than an append operation, so this is what removes
    /// completed/cancelled work and tasks omitted from a revised plan.
    pub fn replace_active_todos<I>(&mut self, todos: I)
    where
        I: IntoIterator<Item = String>,
    {
        self.active_todos.clear();
        for todo in todos {
            push_unique(&mut self.active_todos, todo);
        }
    }

    pub fn set_goal(&mut self, goal: impl Into<String>) {
        self.goal.clear();
        self.goal.push(goal.into());
    }

    /// Records the goal for a new user request while preserving current-task
    /// context. This is for same-target elaboration, not strong task pivots.
    pub fn set_request_focus(&mut self, goal: impl Into<String>, anchor: Option<String>) -> bool {
        let next = goal.into();
        if is_continuation_request(&next) {
            return false;
        }
        let same_goal = self.goal.first().map(String::as_str) == Some(next.as_str());
        let same_anchor = self.task_anchor == anchor;
        if same_goal && same_anchor {
            return false;
        }
        self.set_goal(next);
        self.task_anchor = anchor;
        // Same-target refinement should keep the current checklist. Only a real
        // task switch drops todos, and that flows through `rebind_current_task`.
        if !same_anchor {
            self.active_todos.clear();
        }
        true
    }

    /// Records a strong task rebind inside the same session. Clears active
    /// task-scoped steering state while keeping workspace history such as
    /// changed files and a bounded switch trail for later diagnosis.
    pub fn rebind_current_task(&mut self, goal: impl Into<String>, anchor: Option<String>) -> bool {
        let next = goal.into();
        if is_continuation_request(&next) {
            return false;
        }
        if self.goal.first().map(String::as_str) == Some(next.as_str())
            && self.task_anchor == anchor
        {
            return false;
        }
        let from = focus_label(
            self.task_anchor.as_deref(),
            self.goal.first().map(String::as_str),
        );
        let to = focus_label(anchor.as_deref(), Some(next.as_str()));
        if !from.is_empty() && !to.is_empty() && from != to {
            push_unique(&mut self.recent_task_switches, format!("{from} -> {to}"));
        }
        self.set_goal(next);
        self.task_anchor = anchor;
        self.files_inspected.clear();
        self.open_questions.clear();
        self.active_todos.clear();
        self.state_notes.clear();
        true
    }

    /// Backward-compatible helper used by older call sites/tests. Equivalent
    /// to setting the current request focus without an anchor.
    pub fn set_goal_for_request(&mut self, goal: impl Into<String>) -> bool {
        self.set_request_focus(goal, None)
    }

    /// Replace the boot placeholder with the first real user request.
    /// Returns true only when the goal changed.
    pub fn set_goal_if_placeholder(&mut self, goal: impl Into<String>) -> bool {
        let next = goal.into();
        if self.goal.first().map(|s| s.as_str()) == Some(PLACEHOLDER_GOAL) || self.goal.is_empty() {
            self.set_goal(next);
            return true;
        }
        false
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

/// Stable fingerprint for a memory state. Used to avoid no-op transcript
/// rewrites when the block didn't actually change.
pub fn fingerprint(memory: &WorkingMemory) -> String {
    render(memory)
}

/// Recover memory from the canonical harness slot in a stored transcript.
///
/// Working memory is always spliced immediately after the system prompt.
/// Scanning from the tail would let a model-echoed `[nex:working-memory]`
/// block overwrite the real state on session load.
pub fn recover_from_history(
    history: &[crate::agent::native::provider::ChatMessage],
) -> Option<WorkingMemory> {
    let mut idx = 0usize;
    if history.first().is_some_and(|m| m.role == "system") {
        idx = 1;
    }
    let msg = history.get(idx)?;
    if msg.role != "assistant" {
        return None;
    }
    let text = msg
        .content
        .as_ref()
        .and_then(crate::agent::native::provider::Content::as_text)?;
    if !text.starts_with(MARKER) {
        return None;
    }
    WorkingMemory::parse_rendered(text)
}

/// True when the user is asking to resume the current task rather than start
/// a new one. Conservative: extra task content (`继续写测试`) is a new request.
pub fn is_continuation_request(text: &str) -> bool {
    let normalized = normalize_continuation(text);
    !normalized.is_empty() && CONTINUATION_PHRASES.contains(&normalized.as_str())
}

fn normalize_continuation(text: &str) -> String {
    let stripped = text.trim().trim_matches(is_continuation_punct).trim();
    let mut out = String::with_capacity(stripped.len());
    let mut prev_space = false;
    for c in stripped.chars() {
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
            continue;
        }
        prev_space = false;
        out.push(if c.is_ascii_alphabetic() {
            c.to_ascii_lowercase()
        } else {
            c
        });
    }
    out
}

fn is_continuation_punct(c: char) -> bool {
    matches!(
        c,
        '。' | '．' | '.' | '！' | '!' | '？' | '?' | '…' | '~' | '～' | '，' | ','
    )
}

/// Resume-only utterances after [`normalize_continuation`]. Keep this list
/// tight so a redirected follow-up is still treated as a new task.
const CONTINUATION_PHRASES: &[&str] = &[
    "继续",
    "请继续",
    "继续吧",
    "继续呀",
    "接着",
    "接着做",
    "接着来",
    "接着干",
    "继续执行",
    "继续任务",
    "继续工作",
    "继续刚才的",
    "继续刚才的任务",
    "继续上次",
    "继续上次的",
    "继续上次的任务",
    "从中断的地方继续",
    "从停下的地方继续",
    "从上次停下的地方继续",
    "接着上次",
    "continue",
    "please continue",
    "continue please",
    "keep going",
    "resume",
    "go on",
    "pick up where you left off",
    "pick up where we left off",
];

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

fn focus_label(anchor: Option<&str>, goal: Option<&str>) -> String {
    if let Some(anchor) = anchor.filter(|anchor| !anchor.trim().is_empty()) {
        return anchor.to_string();
    }
    goal.unwrap_or("").trim().chars().take(80).collect()
}

/// Render the memory block to be spliced into the live transcript as a
/// stable assistant message. The format is byte-stable across turns so it
/// doesn't perturb the provider's prefix cache unless the content
/// actually changed.
pub fn render(memory: &WorkingMemory) -> String {
    let mut s = String::with_capacity(640);
    s.push_str(MARKER);
    s.push('\n');
    if !memory.goal.is_empty() {
        s.push_str("Goal:\n");
        for g in &memory.goal {
            s.push_str(&format!("- {g}\n"));
        }
    }
    if let Some(anchor) = memory.task_anchor.as_deref() {
        s.push_str("Task anchor:\n");
        s.push_str(&format!("- {anchor}\n"));
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
    if !memory.active_todos.is_empty() {
        s.push_str("Open tasks:\n");
        for todo in &memory.active_todos {
            s.push_str(&format!("- {todo}\n"));
        }
    }
    if !memory.state_notes.is_empty() {
        s.push_str("State notes:\n");
        s.push_str(memory.state_notes.trim_end());
        s.push('\n');
    }
    if !memory.recent_task_switches.is_empty() {
        s.push_str("Recent task switches:\n");
        for switch in &memory.recent_task_switches {
            s.push_str(&format!("- {switch}\n"));
        }
    }
    s.push_str("[memory updated; do not re-render unless a hook updates this block]\n");
    if s.len() > MEMORY_TOTAL_BYTES {
        let mut cut = MEMORY_TOTAL_BYTES.saturating_sub(16);
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n[truncated]\n");
    }
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
    fn render_caps_total_block_bytes() {
        let mut m = WorkingMemory::new();
        m.goal = vec!["g".repeat(4000)];
        m.task_anchor = Some("SettlementRelation/index".repeat(24));
        m.files_inspected = vec!["p".repeat(400); 16];
        m.files_changed = vec!["c".repeat(400); 16];
        m.open_questions = vec!["q".repeat(200); 16];
        m.state_notes = "n".repeat(MAX_NOTES_BYTES);
        m.recent_task_switches = vec!["a -> b".repeat(32); 8];
        let rendered = render(&m);
        assert!(
            rendered.len() <= MEMORY_TOTAL_BYTES + 32,
            "rendered {} bytes",
            rendered.len()
        );
        assert!(rendered.contains("[truncated]"));
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

    #[test]
    fn placeholder_goal_is_replaced_once() {
        let mut m = WorkingMemory::new();
        m.set_goal(PLACEHOLDER_GOAL);
        assert!(m.set_goal_if_placeholder("真实任务目标"));
        assert_eq!(m.goal, vec!["真实任务目标"]);
        // Subsequent attempts do not overwrite the real goal.
        assert!(!m.set_goal_if_placeholder("另一个目标"));
        assert_eq!(m.goal, vec!["真实任务目标"]);
    }

    #[test]
    fn new_request_replaces_stale_goal() {
        let mut m = WorkingMemory::new();
        m.set_goal("修复登录");
        m.replace_active_todos(["改登录页".to_string()]);
        assert!(m.set_request_focus("实现导出", Some("Export/index".to_string())));
        assert_eq!(m.goal, vec!["实现导出"]);
        assert_eq!(m.task_anchor.as_deref(), Some("Export/index"));
        assert!(m.active_todos.is_empty());
        assert!(!m.set_request_focus("实现导出", Some("Export/index".to_string())));
        assert!(m.active_todos.is_empty());
    }

    #[test]
    fn same_target_refinement_keeps_active_todos() {
        let mut m = WorkingMemory::new();
        m.set_goal("结算关系列表按编码合并单元格");
        m.task_anchor = Some("SettlementRelation/index".to_string());
        m.replace_active_todos(["实现合并逻辑".to_string(), "补测试".to_string()]);

        assert!(m.set_request_focus(
            "同页补充规则：仅连续且编码相同的行才合并",
            Some("SettlementRelation/index".to_string())
        ));
        assert_eq!(
            m.goal,
            vec!["同页补充规则：仅连续且编码相同的行才合并"]
        );
        assert_eq!(m.task_anchor.as_deref(), Some("SettlementRelation/index"));
        assert_eq!(m.active_todos, vec!["实现合并逻辑", "补测试"]);
    }

    #[test]
    fn strong_rebind_clears_task_scoped_state_and_records_switch() {
        let mut m = WorkingMemory::new();
        m.set_goal("修复 SettlementRelationRuleConfig/form 回显");
        m.task_anchor = Some("SettlementRelationRuleConfig/form".to_string());
        m.record_file_inspected("rule.tsx");
        m.record_open_question("xmSelect 时序为何不稳定");
        m.replace_active_todos(["修回显".to_string()]);
        m.append_note("旧模块上下文");

        assert!(m.rebind_current_task(
            "结算关系列表按编码合并单元格",
            Some("SettlementRelation/index".to_string())
        ));
        assert_eq!(m.goal, vec!["结算关系列表按编码合并单元格"]);
        assert_eq!(m.task_anchor.as_deref(), Some("SettlementRelation/index"));
        assert!(m.files_inspected.is_empty());
        assert!(m.open_questions.is_empty());
        assert!(m.active_todos.is_empty());
        assert!(m.state_notes.is_empty());
        assert_eq!(
            m.recent_task_switches,
            vec!["SettlementRelationRuleConfig/form -> SettlementRelation/index"]
        );
    }

    #[test]
    fn continuation_request_keeps_goal_and_todos() {
        let mut m = WorkingMemory::new();
        m.set_goal("实现导出");
        m.replace_active_todos(["写实现".to_string(), "跑测试".to_string()]);

        for utterance in [
            "继续",
            "请继续。",
            "continue",
            "Keep going",
            "从中断的地方继续",
        ] {
            assert!(
                !m.set_goal_for_request(utterance),
                "{utterance} must not count as a new task"
            );
            assert_eq!(m.goal, vec!["实现导出"]);
            assert_eq!(m.active_todos, vec!["写实现", "跑测试"]);
        }

        assert!(m.set_goal_for_request("继续写测试"));
        assert_eq!(m.goal, vec!["继续写测试"]);
        assert!(m.active_todos.is_empty());
    }

    #[test]
    fn todo_and_tool_error_lifecycle_is_reconciled() {
        let mut m = WorkingMemory::new();
        m.replace_active_todos(["写实现".to_string(), "跑测试".to_string()]);
        m.replace_active_todos(["跑测试".to_string()]);
        assert_eq!(m.active_todos, vec!["跑测试"]);

        m.record_tool_error("bash: exit code: 1");
        m.record_tool_error("read_file: missing file");
        m.resolve_tool_errors("bash");
        assert!(!m.open_questions.iter().any(|q| q.contains("bash:")));
        assert!(m.open_questions.iter().any(|q| q.contains("read_file:")));
    }

    #[test]
    fn parse_and_recover_rendered_memory() {
        let mut m = WorkingMemory::new();
        m.set_goal("ship v1");
        m.task_anchor = Some("src/index.ts".to_string());
        m.record_file_inspected("src/main.rs");
        m.record_file_changed("src/app.rs");
        m.record_open_question("verify cache ratio");
        m.append_note("user prefers Chinese responses");
        m.recent_task_switches
            .push("auth/login -> billing/list".to_string());
        let rendered = render(&m);
        let parsed = WorkingMemory::parse_rendered(&rendered).expect("memory block");
        assert_eq!(parsed.goal, m.goal);
        assert_eq!(parsed.task_anchor, m.task_anchor);
        assert_eq!(parsed.files_inspected, m.files_inspected);
        assert_eq!(parsed.files_changed, m.files_changed);
        assert_eq!(parsed.open_questions, m.open_questions);
        assert_eq!(parsed.state_notes, m.state_notes);
        assert_eq!(parsed.recent_task_switches, m.recent_task_switches);

        let history = vec![
            crate::agent::native::provider::ChatMessage::system("sys"),
            crate::agent::native::provider::ChatMessage::assistant(rendered),
        ];
        let recovered = recover_from_history(&history).expect("recovered memory");
        assert_eq!(recovered.goal, m.goal);
        assert_eq!(recovered.task_anchor, m.task_anchor);
        assert_eq!(recovered.files_changed, m.files_changed);
        assert_eq!(recovered.recent_task_switches, m.recent_task_switches);
    }

    #[test]
    fn recover_from_history_ignores_model_echo_at_tail() {
        let mut real = WorkingMemory::new();
        real.set_goal("ship v1");
        real.task_anchor = Some("src/index.ts".to_string());
        real.record_file_changed("src/app.rs");
        let canonical = render(&real);

        let echo = WorkingMemory::new();
        let echo_block = render(&echo);

        let history = vec![
            crate::agent::native::provider::ChatMessage::system("sys"),
            crate::agent::native::provider::ChatMessage::assistant(canonical),
            crate::agent::native::provider::ChatMessage::user("继续"),
            crate::agent::native::provider::ChatMessage::assistant(echo_block),
        ];
        let recovered = recover_from_history(&history).expect("recovered memory");
        assert_eq!(recovered.goal, vec!["ship v1"]);
        assert_eq!(recovered.task_anchor.as_deref(), Some("src/index.ts"));
        assert_eq!(recovered.files_changed, vec!["src/app.rs"]);
    }
}
