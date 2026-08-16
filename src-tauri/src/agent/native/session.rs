//! The harness main loop: assemble request → stream → accumulate tool calls →
//! execute → feed `role=tool` results back → repeat. Bounded by `max_steps`,
//! a repeated-success/no-progress lease, and cooperative cancellation.
//!
//! The transcript (`Vec<ChatMessage>`) is append-only and owned by the caller
//! (per-session state); this module only pushes new turns onto it.

use std::cell::{Cell, RefCell};
use std::collections::{HashSet, VecDeque};
use std::ffi::OsString;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::{self as acp};

use super::provider::{
    ensure_unique_tool_call_ids, ChatMessage, ChatRequest, ChatToolCall, ChatToolCallFunction,
    Chunk, Content, NativeToolCall, Provider, ReasoningControl, StopReasonKind, ToolSpec, Usage,
    PARSE_ERROR_KEY,
};
use super::stats;
use super::tools::todo::{parse_todos, TodoStatus};
use super::tools::{truncate_output, ToolCtx, ToolRegistry, PARTIAL_MARKER};
use super::{budget, context};

/// Read-only tool calls in one round run concurrently, capped by this.
const PARALLEL_BATCH_LIMIT: usize = 8;
/// Progress lease: warn / pause after this many consecutive no-progress rounds.
const LEASE_WARN_ROUNDS: u32 = 8;
const LEASE_PAUSE_ROUNDS: u32 = 16;
/// Sliding window of recent tool-round signatures. Consecutive-only comparison
/// let A→B→A→B reset the lease every turn.
const SIGNATURE_WINDOW: usize = 8;
/// Abort a hung provider stream if no chunk arrives within this idle window.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Subagent final answers larger than this go to disk behind a stable ref.
const SUBAGENT_INLINE_LIMIT: usize = 20_000;

/// OpenCode-aligned wrap-up when a configured `max_steps` cap is hit: tools are
/// disabled and the model must summarize progress + recommend next steps.
const MAX_STEPS_PROMPT: &str = "CRITICAL - MAXIMUM STEPS REACHED\n\n\
The maximum number of steps allowed for this task has been reached. Tools are \
disabled until next user input. Respond with text only.\n\n\
STRICT REQUIREMENTS:\n\
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)\n\
2. MUST provide a text response summarizing work done so far\n\
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use\n\n\
Response must include:\n\
- Statement that maximum steps for this agent have been reached\n\
- Summary of what has been accomplished so far\n\
- List of any remaining tasks that were not completed\n\
- Recommendations for what should be done next\n\n\
Any attempt to use tools is a critical violation. Respond with text ONLY.";

/// Everything one prompt turn needs to run.
pub struct TurnEnv {
    /// Agent-side connection used for notifications + permission requests.
    pub conn: Arc<acp::AgentSideConnection>,
    pub session_id: acp::SessionId,
    pub provider: Arc<dyn Provider>,
    pub registry: Rc<ToolRegistry>,
    /// Tool specs handed to the model (canonical order from the registry).
    pub tool_specs: Vec<super::provider::ToolSpec>,
    pub model: String,
    pub reasoning: ReasoningControl,
    /// Hard cap on tool-call rounds. Values below 1 are treated as 1
    /// (unlimited loops are not allowed).
    pub max_steps: u32,
    /// Live session mode (`code`/`ask`/`plan`/`auto`). Re-read on every tool
    /// call so mid-turn switches (especially Auto) take effect immediately.
    pub mode_id: Rc<RefCell<String>>,
    /// True after entering Plan until the user confirms code/auto execution.
    pub plan_pending_confirm: Rc<Cell<bool>>,
    /// Cooperative cancellation flag set by `session/cancel`.
    pub cancelled: Rc<Cell<bool>>,
    /// Tools the user chose "always allow" for (session-scoped).
    pub auto_allow: Rc<RefCell<HashSet<String>>>,
    pub tool_ctx: ToolCtx,
    /// Context window in tokens; `0` disables compression.
    pub context_window: u64,
    /// Accumulated provider usage for the turn (observability).
    pub usage: RefCell<Usage>,
    /// Per-turn context-engine stats (compaction, partials, cache hit).
    /// Surfaced through the `prompt` response's `_meta.contextStats` so
    /// dashboards can monitor optimization efficacy without a separate
    /// log scrape.
    pub stats: RefCell<stats::ContextStats>,
}

impl TurnEnv {
    fn read_only_mode(&self) -> bool {
        matches!(self.mode_id.borrow().as_str(), "ask" | "plan")
    }

    fn auto_approve(&self) -> bool {
        self.mode_id.borrow().as_str() == "auto"
    }
}

/// Everything a `task`/`fleet` invocation needs to spin up isolated subagent
/// turns. Built once per prompt by the agent and shared through [`ToolCtx`].
pub struct SubagentHarness {
    pub conn: Arc<acp::AgentSideConnection>,
    /// Parent session the subagent notifications/permissions are routed to.
    pub parent_session_id: acp::SessionId,
    pub provider: Arc<dyn Provider>,
    /// Subagent registry: the builtin set minus the orchestration tools.
    pub registry: Rc<ToolRegistry>,
    pub tool_specs: Vec<ToolSpec>,
    pub model: String,
    pub reasoning: ReasoningControl,
    pub max_sub_steps: u32,
    /// Legacy configured fleet concurrency. Shared-workspace fleet execution
    /// is deliberately serialized until isolated worktrees/conflict handling
    /// exist, so this is retained for config compatibility only.
    pub concurrency: usize,
    pub cwd: PathBuf,
    pub bash_timeout: Duration,
    pub path_env: OsString,
    pub archive_dir: PathBuf,
    /// Effective context window for the parent session; passed through so
    /// subagent transcripts honour the same hard budget.
    pub context_window: u64,
    /// Shared cancellation flag of the parent turn.
    pub cancelled: Rc<Cell<bool>>,
    /// Parent session mode (Auto skips approval prompts for subagents too).
    pub mode_id: Rc<RefCell<String>>,
    /// Parent mutation log. Child workspace edits write here so auto-review
    /// and the parent transcript's mutation outcome stay accurate.
    pub mutations: Rc<RefCell<Vec<String>>>,
    /// Parent working memory. Child discoveries/edits are session state, not
    /// disposable side effects of an isolated transcript.
    pub memory: Rc<RefCell<super::memory::WorkingMemory>>,
}

/// Runs one isolated subagent turn and returns only its final answer. Huge
/// answers are spilled to `<archive_dir>/subagent-<uuid>.txt` and a stable
/// `ref:` marker is returned instead (read back via `read_subagent_result`).
pub async fn run_subagent(harness: &SubagentHarness, task: &str) -> Result<String, String> {
    if harness.cancelled.get() {
        return Err("cancelled".to_string());
    }
    // The child shares operational memory so file discoveries, mutations and
    // tool errors flow back to the parent. Its task goal and scratch todo list,
    // however, are transcript-local and must not replace the parent's state.
    let (parent_goal, parent_todos) = {
        let memory = harness.memory.borrow();
        (memory.goal.clone(), memory.active_todos.clone())
    };
    let tool_ctx = ToolCtx {
        cwd: harness.cwd.clone(),
        bash_timeout: harness.bash_timeout,
        path_env: harness.path_env.clone(),
        archive_dir: harness.archive_dir.clone(),
        jobs: Rc::new(RefCell::new(super::tools::jobs::JobTable::default())),
        // No harness on the child: subagents cannot spawn subagents.
        harness: None,
        mutations: harness.mutations.clone(),
        // Parent mode is not mutable from subagents (`switch_mode` is filtered out).
        mode_id: None,
        memory: harness.memory.clone(),
    };
    let env = TurnEnv {
        conn: harness.conn.clone(),
        session_id: harness.parent_session_id.clone(),
        provider: harness.provider.clone(),
        tool_specs: harness.tool_specs.clone(),
        registry: harness.registry.clone(),
        model: harness.model.clone(),
        reasoning: harness.reasoning,
        max_steps: harness.max_sub_steps,
        mode_id: harness.mode_id.clone(),
        plan_pending_confirm: Rc::new(Cell::new(false)),
        cancelled: harness.cancelled.clone(),
        auto_allow: Rc::new(RefCell::new(HashSet::new())),
        tool_ctx,
        context_window: harness.context_window,
        usage: RefCell::new(Usage::default()),
        stats: RefCell::new(stats::ContextStats::with_window(harness.context_window)),
    };
    let mut messages = vec![ChatMessage::system(context::subagent_prompt(
        &harness.cwd,
        &harness.model,
    ))];
    let _ = run_turn(&env, &mut messages, Content::Text(task.to_string())).await;
    {
        let mut memory = harness.memory.borrow_mut();
        memory.goal = parent_goal;
        memory.active_todos = parent_todos;
    }
    let answer = final_answer(&messages);
    if answer.chars().count() > SUBAGENT_INLINE_LIMIT {
        let _ = std::fs::create_dir_all(&harness.archive_dir);
        let name = format!("subagent-{}.txt", uuid::Uuid::new_v4().simple());
        let path = harness.archive_dir.join(&name);
        std::fs::write(&path, &answer)
            .map_err(|e| format!("failed to store subagent result: {e}"))?;
        let chars = answer.chars().count();
        return Ok(format!(
            "subagent 结果过大（{chars} 字符）已保存。ref: {name}\n用 read_subagent_result 分页读取。\n开头预览：\n{}",
            truncate_output(answer, 800)
        ));
    }
    Ok(answer)
}

/// The subagent's final answer: last assistant message without tool calls
/// (fallback: last assistant text at all).
fn final_answer(messages: &[ChatMessage]) -> String {
    let mut last_assistant: Option<&str> = None;
    for m in messages.iter().rev() {
        if m.role != "assistant" {
            continue;
        }
        if m.tool_calls.is_none() {
            if let Some(c) = m.content.as_ref().and_then(Content::as_text) {
                return c.to_string();
            }
        } else if last_assistant.is_none() {
            if let Some(c) = m.content.as_ref().and_then(Content::as_text) {
                last_assistant = Some(c);
            }
        }
    }
    last_assistant
        .map(|s| s.to_string())
        .unwrap_or_else(|| "(subagent returned no answer)".to_string())
}

/// Short argument summary for mutation log entries.
fn brief_summary(args: &serde_json::Value) -> String {
    let s = args.to_string();
    s.chars().take(100).collect()
}

/// Runs one prompt turn end-to-end and returns the ACP stop reason.
pub async fn run_turn(
    env: &TurnEnv,
    messages: &mut Vec<ChatMessage>,
    content: Content,
) -> acp::StopReason {
    // Every real user request can start a new task. Extract text from both
    // plain and multimodal turns (skipping the injected mode preamble), then
    // replace the stale goal unless this is an internal slash-command turn.
    if let Some(goal) = goal_from_content(&content) {
        if !goal.starts_with('/') {
            env.tool_ctx.memory.borrow_mut().set_goal_for_request(goal);
        }
    }
    messages.push(ChatMessage::user_content(content));

    let mut steps = 0u32;
    let mut no_progress = 0u32;
    let mut recent_signatures: VecDeque<u64> = VecDeque::with_capacity(SIGNATURE_WINDOW);
    loop {
        if env.cancelled.get() {
            return acp::StopReason::Cancelled;
        }

        // Budget-driven compression before assembling the request.
        // `window = 0` is the legacy sentinel for "compression disabled",
        // kept for users who deliberately want the agent to send an
        // unbounded transcript.
        let budget = budget::resolve_for_session(
            env.provider.as_ref(),
            &env.model,
            env.reasoning,
            env.context_window,
        );
        let outcome = {
            let mem = env.tool_ctx.memory.borrow();
            budget::enforce_with_memory(
                messages,
                budget,
                &env.tool_ctx.archive_dir,
                Some(&mem),
            )
        };
        {
            let mut s = env.stats.borrow_mut();
            s.compaction_passes = outcome.passes as u32;
            s.snipped_messages = outcome.total_snipped as u32;
            s.folded_messages = outcome.total_folded as u32;
            s.archive_files_written = outcome.archive_files.len() as u32;
            s.final_tokens = outcome.final_tokens;
            s.initial_tokens = outcome.initial_tokens;
            s.used_summary_fallback = outcome.used_summary_fallback;
            s.over_budget = outcome.over_budget;
            s.context_window = env.context_window;
        }
        if outcome.passes > 0 {
            log::debug!(
                "context budget: initial={} final={} budget={} passes={} snipped={} folded={} over_budget={}",
                outcome.initial_tokens,
                outcome.final_tokens,
                budget.prompt_budget,
                outcome.passes,
                outcome.total_snipped,
                outcome.total_folded,
                outcome.over_budget,
            );
        }

        // Refresh or re-insert the working-memory block. Byte-stable when
        // the state didn't change, so prefix cache stays warm.
        crate::agent::native::tools::ensure_working_memory(
            messages,
            &env.tool_ctx.memory.borrow(),
        );

        if outcome.over_budget {
            let notice = "上下文超出模型窗口，压缩后仍无法放入本轮请求。请开新会话，或在设置里提高该模型的上下文窗口。";
            emit_text(env, notice).await;
            // Persist an assistant turn so the next prompt is not two user
            // messages in a row (the user message was already pushed).
            messages.push(ChatMessage::assistant(notice));
            return acp::StopReason::EndTurn;
        }

        // Hit the configured step cap: one final text-only turn (OpenCode
        // style), then stop. Defensive `.max(1)` prevents externally built
        // TurnEnv values from reintroducing an unlimited loop.
        let wrap_up = steps >= env.max_steps.max(1);
        if wrap_up {
            messages.push(ChatMessage::user(MAX_STEPS_PROMPT));
        }

        // Heal empty / reused tool-call ids before the wire request. Models and
        // resumed archives sometimes repeat ids; OpenAI-compatible gateways
        // reject those with a 400 (`Duplicate value for 'tool_call_id'`).
        ensure_unique_tool_call_ids(messages);

        let request = ChatRequest {
            model: env.model.clone(),
            messages: messages.clone(),
            tools: if wrap_up {
                Vec::new()
            } else {
                env.tool_specs.clone()
            },
            reasoning: env.reasoning,
            max_tokens: None,
            temperature: None,
        };

        let mut rx = match env.provider.stream(request).await {
            Ok(rx) => rx,
            Err(e) => {
                emit_text(env, &format!("模型请求失败：{e}")).await;
                return acp::StopReason::EndTurn;
            }
        };

        // Consume one provider stream: accumulate text + complete tool calls.
        let mut text = String::new();
        let mut calls: Vec<NativeToolCall> = Vec::new();
        let mut provider_error: Option<String> = None;
        let mut provider_stop = StopReasonKind::EndTurn;
        loop {
            if env.cancelled.get() {
                drop(rx);
                return acp::StopReason::Cancelled;
            }
            let chunk = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, rx.recv()).await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) => {
                    drop(rx);
                    if !text.trim().is_empty() {
                        messages.push(ChatMessage::assistant(text));
                    }
                    emit_text(
                        env,
                        "模型流超过 60 秒没有新的输出，本轮已中止。",
                    )
                    .await;
                    return acp::StopReason::EndTurn;
                }
            };
            match chunk {
                Chunk::Text(t) => {
                    text.push_str(&t);
                    emit_text(env, &t).await;
                }
                Chunk::Thinking(t) => emit_thought(env, &t).await,
                Chunk::ToolCall(c) => {
                    // Wrap-up turns advertise no tools; ignore any stray calls.
                    if !wrap_up {
                        calls.push(c);
                    }
                }
                Chunk::Done { stop_reason, usage } => {
                    provider_stop = stop_reason;
                    if let Some(u) = usage {
                        let mut acc = env.usage.borrow_mut();
                        acc.prompt_tokens += u.prompt_tokens;
                        acc.completion_tokens += u.completion_tokens;
                        acc.cache_hit_tokens += u.cache_hit_tokens;
                        let mut s = env.stats.borrow_mut();
                        s.cache_hit_tokens = acc.cache_hit_tokens;
                        s.prompt_tokens = acc.prompt_tokens;
                    }
                    break;
                }
                Chunk::Error(e) => {
                    provider_error = Some(e);
                    break;
                }
            }
        }
        drop(rx);

        if let Some(e) = provider_error {
            emit_text(env, &format!("模型流中断：{e}")).await;
            return acp::StopReason::EndTurn;
        }

        // A `length` finish reason means the model's message may be partial;
        // in particular, executing a partially emitted tool call would be
        // unsafe. Preserve any visible text, surface a concrete recovery
        // message, and return the protocol's MaxTokens reason instead of
        // silently treating this as a normal completed turn.
        if provider_stop == StopReasonKind::MaxTokens {
            let notice = "模型输出因达到 token 限制而被截断；本轮未执行任何未完成的工具调用。请缩小任务、提高模型的最大输出，或在新一轮继续。";
            if !text.trim().is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(notice);
            messages.push(ChatMessage::assistant(text));
            emit_text(env, notice).await;
            return acp::StopReason::MaxTokens;
        }

        // Wrap-up or natural end: persist assistant text and finish the turn.
        if wrap_up || calls.is_empty() {
            if !text.trim().is_empty() {
                messages.push(ChatMessage::assistant(text));
            }
            return acp::StopReason::EndTurn;
        }

        // Record the assistant turn with its tool calls (OpenAI wire format).
        let wire_calls: Vec<ChatToolCall> = calls
            .iter()
            .map(|c| ChatToolCall {
                id: c.id.clone(),
                typ: "function".to_string(),
                function: ChatToolCallFunction {
                    name: c.name.clone(),
                    arguments: serde_json::to_string(&c.arguments).unwrap_or_default(),
                },
            })
            .collect();
        messages.push(ChatMessage::assistant_tool_calls(
            wire_calls,
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            },
        ));

        // Execute the requested tool calls: consecutive read-only calls run
        // as one parallel batch, mutating ones run serially and get logged.
        let results = execute_calls(env, &calls).await;
        let round_signature = tool_round_signature(&calls, &results);
        let all_failed = results.iter().all(Result::is_err);
        // Same tool names, arguments, and results seen in the recent window
        // means the model is looping even if each call returned `Ok`. A
        // changing result is a new signature and does not match.
        let repeated_success = recent_signatures.contains(&round_signature)
            && results.iter().any(Result::is_ok);
        for (call, result) in calls.iter().zip(results) {
            messages.push(ChatMessage::tool_result(
                call.id.clone(),
                result.unwrap_or_else(|e| e),
            ));
        }
        if env.cancelled.get() {
            return acp::StopReason::Cancelled;
        }

        steps += 1;
        // Do not hard-stop here: the next loop iteration runs the OpenCode-style
        // text-only wrap-up when `steps >= max_steps`.

        // Progress lease: all-failed rounds and identical successful rounds
        // both count as no-progress. Warn at 8 consecutive, pause at 16.
        if all_failed || repeated_success {
            no_progress += 1;
            if no_progress == LEASE_WARN_ROUNDS {
                emit_text(
                    env,
                    "已连续多轮没有实质进展（工具持续失败或重复返回相同结果）。建议换一个思路或先排查失败原因。",
                )
                .await;
            }
            if no_progress >= LEASE_PAUSE_ROUNDS {
                emit_text(
                    env,
                    "连续无进展轮次过多，本轮已暂停。请调整策略后重新发起。",
                )
                .await;
                return acp::StopReason::EndTurn;
            }
        } else {
            no_progress = 0;
        }
        recent_signatures.push_back(round_signature);
        if recent_signatures.len() > SIGNATURE_WINDOW {
            recent_signatures.pop_front();
        }
    }
}

fn goal_from_content(content: &Content) -> Option<String> {
    let text = match content {
        Content::Text(text) => Some(text.as_str()),
        Content::Parts(parts) => parts
            .iter()
            .filter(|part| part.typ == "text")
            .filter_map(|part| part.text.as_deref())
            .find(|text| !text.trim_start().starts_with("[Mode:")),
    }?;
    let trimmed = text.trim();
    let first_line = trimmed.lines().next().unwrap_or(trimmed).trim();
    let goal: String = first_line.chars().take(160).collect();
    (!goal.is_empty()).then_some(goal)
}

/// Compact fingerprint of one tool-call round. The raw data never leaves this
/// process; hashing avoids adding large tool output bodies to loop state.
fn tool_round_signature(calls: &[NativeToolCall], results: &[Result<String, String>]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for (call, result) in calls.iter().zip(results) {
        call.name.hash(&mut hasher);
        call.arguments.to_string().hash(&mut hasher);
        match result {
            Ok(output) => {
                true.hash(&mut hasher);
                output.hash(&mut hasher);
            }
            Err(error) => {
                false.hash(&mut hasher);
                error.hash(&mut hasher);
            }
        }
    }
    hasher.finish()
}

/// Executes one round of tool calls. Consecutive read-only calls run
/// concurrently (bounded by [`PARALLEL_BATCH_LIMIT`]); every mutating call
/// runs alone, serially, and is recorded in the mutation log.
async fn execute_calls(env: &TurnEnv, calls: &[NativeToolCall]) -> Vec<Result<String, String>> {
    let mut results = Vec::with_capacity(calls.len());
    let mut i = 0usize;
    while i < calls.len() {
        if env.cancelled.get() {
            // Pad the rest so results stay index-aligned with `calls`.
            while results.len() < calls.len() {
                results.push(Err("ERROR: cancelled".to_string()));
            }
            break;
        }
        let read_only = calls[i..]
            .iter()
            .position(|c| !env.registry.get(&c.name).is_some_and(|t| t.read_only()))
            .unwrap_or(calls.len() - i);
        if read_only > 0 {
            let batch = &calls[i..i + read_only];
            if batch.len() == 1 {
                results.push(execute_tool(env, &batch[0]).await);
            } else {
                results.extend(execute_read_only_batch(env, batch).await);
            }
            i += read_only;
        } else {
            // Mutating call: serial, then logged.
            let call = &calls[i];
            let result = execute_tool(env, call).await;
            if result.is_ok() {
                let mut log = env.tool_ctx.mutations.borrow_mut();
                log.push(format!(
                    "{}({}) -> ok",
                    call.name,
                    brief_summary(&call.arguments)
                ));
                if log.len() > 200 {
                    log.drain(..100);
                }
            }
            results.push(result);
            i += 1;
        }
    }
    results
}

/// Runs a batch of read-only tool calls concurrently, returning results in the
/// original call order.
async fn execute_read_only_batch(
    env: &TurnEnv,
    batch: &[NativeToolCall],
) -> Vec<Result<String, String>> {
    let sem = Rc::new(tokio::sync::Semaphore::new(PARALLEL_BATCH_LIMIT));
    let futs = batch.iter().map(|call| {
        let sem = sem.clone();
        async move {
            let _permit = sem.acquire().await;
            execute_tool(env, call).await
        }
    });
    futures::future::join_all(futs).await
}

/// Executes one tool call, streaming ACP tool-call notifications and (for
/// mutating tools) requesting permission first.
async fn execute_tool(env: &TurnEnv, call: &NativeToolCall) -> Result<String, String> {
    let call_id = acp::ToolCallId(Arc::from(call.id.as_str()));
    let tool = env.registry.get(&call.name);
    let title = format!("{}({})", call.name, brief_args(&call.arguments));

    let (kind, read_only) = match tool {
        Some(t) => (t.kind(), t.read_only()),
        None => (acp::ToolKind::Other, false),
    };

    // Announce the tool call (Pending).
    emit_notification(
        env,
        acp::SessionUpdate::ToolCall(acp::ToolCall {
            id: call_id.clone(),
            title: title.clone(),
            kind,
            status: acp::ToolCallStatus::Pending,
            content: vec![],
            locations: vec![],
            raw_input: Some(call.arguments.clone()),
            raw_output: None,
            meta: None,
        }),
    )
    .await;

    if let Some(err) = call
        .arguments
        .get(PARSE_ERROR_KEY)
        .and_then(|v| v.as_str())
    {
        return finish_tool(env, &call_id, false, err).await;
    }

    let Some(tool) = tool else {
        return finish_tool(
            env,
            &call_id,
            false,
            &format!("unknown tool `{}`", call.name),
        )
        .await;
    };

    // Read-only tools run without prompting; mutating ones need permission
    // unless the user already said "always allow" for this tool (bash is
    // keyed by command prefix) or the session runs in `auto` mode.
    if !read_only {
        if env.read_only_mode() {
            return finish_tool(env, &call_id, false, "当前为只读模式，禁止执行写操作/命令").await;
        }
        let allow_key = permission_allow_key(&call.name, &call.arguments);
        if !env.auto_approve() && !env.auto_allow.borrow().contains(&allow_key) {
            match request_permission(env, &call_id, &title, kind, &call.name, &call.arguments)
                .await
            {
                PermissionDecision::Allowed { always } => {
                    if always {
                        env.auto_allow.borrow_mut().insert(allow_key);
                    }
                }
                PermissionDecision::Denied => {
                    return finish_tool(env, &call_id, false, "permission denied by user").await;
                }
                PermissionDecision::TurnCancelled => {
                    return finish_tool(env, &call_id, false, "cancelled").await;
                }
            }
        }
    }

    update_status(env, &call_id, acp::ToolCallStatus::InProgress).await;
    let mode_before = env.mode_id.borrow().clone();
    let result = tokio::select! {
        _ = wait_cancelled(env) => {
            return finish_tool(env, &call_id, false, "cancelled").await;
        }
        result = tool.execute(call.arguments.clone(), &env.tool_ctx) => result,
    };

    // System-driven working-memory updates. The model never rewrites the
    // memory block; the harness observes tool outcomes and folds them in.
    {
        let mut mem = env.tool_ctx.memory.borrow_mut();
        if result.is_ok() {
            mem.resolve_tool_errors(&call.name);
        }
        match result.as_ref() {
            Ok(_) if matches!(call.name.as_str(), "write_file" | "edit_file" | "multi_edit") => {
                if let Some(path) = call.arguments.get("path").and_then(|v| v.as_str()) {
                    mem.record_file_changed(path);
                }
            }
            Ok(_) if matches!(call.name.as_str(), "read_file" | "grep" | "glob" | "ls") => {
                if let Some(path) = call.arguments.get("path").and_then(|v| v.as_str()) {
                    mem.record_file_inspected(path);
                }
            }
            Ok(_) if call.name == "todo_write" => {
                if let Ok(entries) = parse_todos(&call.arguments) {
                    mem.replace_active_todos(entries.into_iter().filter_map(|entry| {
                        matches!(entry.status, TodoStatus::Pending | TodoStatus::InProgress)
                            .then_some(entry.content)
                    }));
                }
            }
            Err(e) => {
                let first_line = e.lines().next().unwrap_or("").to_string();
                if !first_line.is_empty() {
                    mem.record_tool_error(format!("{}: {}", call.name, first_line));
                }
            }
            _ => {}
        }
    }

    // Tool-result metrics. Every successful tool call produces a result
    // message; a `partial` marker on it (see Ticket 3) signals the model
    // only saw a preview head, which we count separately so dashboards
    // can spot the "model reasons on partial info" failure mode.
    {
        let body = result.as_ref().map(|s| s.as_str()).unwrap_or("");
        if !call.name.is_empty() {
            let mut s = env.stats.borrow_mut();
            s.tool_results += 1;
            if body.contains(PARTIAL_MARKER) {
                s.partial_tool_results += 1;
            }
        }
    }

    // Mirror the model's todo list as an ACP plan update.
    if call.name == "todo_write" {
        match parse_todos(&call.arguments) {
            Ok(entries) => {
                let plan = acp::Plan {
                    entries: entries
                        .iter()
                        .map(|e| acp::PlanEntry {
                            content: e.content.clone(),
                            priority: acp::PlanEntryPriority::Medium,
                            status: e.status.to_acp(),
                            meta: None,
                        })
                        .collect(),
                    meta: None,
                };
                emit_notification(env, acp::SessionUpdate::Plan(plan)).await;
            }
            Err(e) => log::warn!(
                "todo_write arguments not parseable, plan update skipped: {e}; args: {}",
                call.arguments
            ),
        }
    }

    // Mode elevation gates:
    // - entering plan arms `plan_pending_confirm`; any later switch into
    //   code/auto (including plan→ask→code) requires explicit approval.
    // - any model-driven switch into `auto` also requires approval, even
    //   from ask/code that never entered plan. `auto` suppresses every
    //   subsequent permission prompt.
    // Rejected switches revert the mode cell.
    if call.name == "switch_mode" && result.is_ok() {
        let current = env.mode_id.borrow().clone();
        if current == "plan" {
            env.plan_pending_confirm.set(true);
        }
        let elevating_to_auto = current == "auto" && mode_before != "auto";
        let leaving_plan_to_exec =
            matches!(current.as_str(), "code" | "auto") && env.plan_pending_confirm.get();
        if elevating_to_auto || leaving_plan_to_exec {
            match request_mode_elevation_approval(
                env,
                &call_id,
                &mode_before,
                &current,
                env.plan_pending_confirm.get(),
            )
            .await
            {
                PermissionDecision::Allowed { .. } => {
                    if leaving_plan_to_exec {
                        env.plan_pending_confirm.set(false);
                    }
                }
                PermissionDecision::Denied => {
                    *env.mode_id.borrow_mut() = mode_before.clone();
                    let msg = if leaving_plan_to_exec {
                        "用户拒绝执行计划，未切换到执行模式"
                    } else {
                        "用户拒绝切换到 auto，未提权"
                    };
                    return finish_tool(env, &call_id, false, msg).await;
                }
                PermissionDecision::TurnCancelled => {
                    *env.mode_id.borrow_mut() = mode_before;
                    return finish_tool(env, &call_id, false, "cancelled").await;
                }
            }
        }
        let current = env.mode_id.borrow().clone();
        emit_notification(
            env,
            acp::SessionUpdate::CurrentModeUpdate(acp::CurrentModeUpdate {
                current_mode_id: acp::SessionModeId(Arc::from(current.as_str())),
                meta: None,
            }),
        )
        .await;
    }

    finish_tool(
        env,
        &call_id,
        result.is_ok(),
        &result.clone().unwrap_or_else(|e| e),
    )
    .await
}

/// Emits the terminal tool-call update and returns the text fed back to the
/// model (error results get a prefix so the model can react).
async fn finish_tool(
    env: &TurnEnv,
    call_id: &acp::ToolCallId,
    ok: bool,
    output: &str,
) -> Result<String, String> {
    let status = if ok {
        acp::ToolCallStatus::Completed
    } else {
        acp::ToolCallStatus::Failed
    };
    emit_notification(
        env,
        acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate {
            id: call_id.clone(),
            fields: acp::ToolCallUpdateFields {
                status: Some(status),
                raw_output: Some(serde_json::Value::String(output.to_string())),
                ..Default::default()
            },
            meta: None,
        }),
    )
    .await;
    if ok {
        Ok(output.to_string())
    } else {
        Err(format!("ERROR: {output}"))
    }
}

async fn update_status(env: &TurnEnv, call_id: &acp::ToolCallId, status: acp::ToolCallStatus) {
    emit_notification(
        env,
        acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate {
            id: call_id.clone(),
            fields: acp::ToolCallUpdateFields {
                status: Some(status),
                ..Default::default()
            },
            meta: None,
        }),
    )
    .await;
}

enum PermissionDecision {
    Allowed { always: bool },
    Denied,
    TurnCancelled,
}

async fn wait_cancelled(env: &TurnEnv) {
    loop {
        if env.cancelled.get() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Session-scoped always-allow key. Bash is keyed by the command prefix so
/// "always allow `git status`" does not authorize `rm -rf`.
fn permission_allow_key(name: &str, args: &serde_json::Value) -> String {
    if name == "bash" {
        if let Some(cmd) = args.get("command").and_then(|v| v.as_str()) {
            return format!("bash:{}", bash_command_prefix(cmd));
        }
    }
    name.to_string()
}

fn bash_command_prefix(cmd: &str) -> String {
    cmd.split_whitespace().next().unwrap_or(cmd).to_string()
}

/// Confirms a model-driven mode elevation (leaving Plan, or entering auto).
async fn request_mode_elevation_approval(
    env: &TurnEnv,
    call_id: &acp::ToolCallId,
    from_mode: &str,
    target_mode: &str,
    plan_pending: bool,
) -> PermissionDecision {
    use acp::Client as _;

    let title = if plan_pending {
        format!("确认执行计划（切换到 {target_mode}）")
    } else {
        format!("确认切换到 {target_mode}（将自动批准后续所有工具调用）")
    };
    let request = acp::RequestPermissionRequest {
        session_id: env.session_id.clone(),
        tool_call: acp::ToolCallUpdate {
            id: call_id.clone(),
            fields: acp::ToolCallUpdateFields {
                kind: Some(acp::ToolKind::SwitchMode),
                status: Some(acp::ToolCallStatus::Pending),
                title: Some(title),
                raw_input: Some(serde_json::json!({
                    "from": from_mode,
                    "to": target_mode,
                    "planPending": plan_pending,
                })),
                ..Default::default()
            },
            meta: None,
        },
        options: vec![
            acp::PermissionOption {
                id: acp::PermissionOptionId(Arc::from("allow-once")),
                name: "接受并执行".to_string(),
                kind: acp::PermissionOptionKind::AllowOnce,
                meta: None,
            },
            acp::PermissionOption {
                id: acp::PermissionOptionId(Arc::from("reject")),
                name: "拒绝".to_string(),
                kind: acp::PermissionOptionKind::RejectOnce,
                meta: None,
            },
        ],
        meta: None,
    };

    match env.conn.request_permission(request).await {
        Ok(resp) => match resp.outcome {
            acp::RequestPermissionOutcome::Cancelled => PermissionDecision::TurnCancelled,
            acp::RequestPermissionOutcome::Selected { option_id } => match option_id.0.as_ref() {
                "allow-once" | "allow-always" => PermissionDecision::Allowed { always: false },
                _ => PermissionDecision::Denied,
            },
        },
        Err(_) => PermissionDecision::Denied,
    }
}

/// Asks the client (Nex UI) for permission via the existing ACP popup.
async fn request_permission(
    env: &TurnEnv,
    call_id: &acp::ToolCallId,
    title: &str,
    kind: acp::ToolKind,
    tool_name: &str,
    args: &serde_json::Value,
) -> PermissionDecision {
    use acp::Client as _;

    let always_label = if tool_name == "bash" {
        "始终允许该命令前缀".to_string()
    } else {
        "始终允许该工具".to_string()
    };
    let request = acp::RequestPermissionRequest {
        session_id: env.session_id.clone(),
        tool_call: acp::ToolCallUpdate {
            id: call_id.clone(),
            fields: acp::ToolCallUpdateFields {
                kind: Some(kind),
                status: Some(acp::ToolCallStatus::Pending),
                title: Some(title.to_string()),
                raw_input: Some(args.clone()),
                ..Default::default()
            },
            meta: None,
        },
        options: vec![
            acp::PermissionOption {
                id: acp::PermissionOptionId(Arc::from("allow-once")),
                name: "允许一次".to_string(),
                kind: acp::PermissionOptionKind::AllowOnce,
                meta: None,
            },
            acp::PermissionOption {
                id: acp::PermissionOptionId(Arc::from("allow-always")),
                name: always_label,
                kind: acp::PermissionOptionKind::AllowAlways,
                meta: None,
            },
            acp::PermissionOption {
                id: acp::PermissionOptionId(Arc::from("reject")),
                name: "拒绝".to_string(),
                kind: acp::PermissionOptionKind::RejectOnce,
                meta: None,
            },
        ],
        meta: None,
    };

    match env.conn.request_permission(request).await {
        Ok(resp) => match resp.outcome {
            acp::RequestPermissionOutcome::Cancelled => PermissionDecision::TurnCancelled,
            acp::RequestPermissionOutcome::Selected { option_id } => match option_id.0.as_ref() {
                "allow-once" => PermissionDecision::Allowed { always: false },
                "allow-always" => PermissionDecision::Allowed { always: true },
                _ => PermissionDecision::Denied,
            },
        },
        // Client can't answer (e.g. dropped): fail safe.
        Err(_) => PermissionDecision::Denied,
    }
}

async fn emit_text(env: &TurnEnv, text: &str) {
    emit_notification(
        env,
        acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk {
            content: acp::ContentBlock::Text(acp::TextContent {
                annotations: None,
                text: text.to_string(),
                meta: None,
            }),
            meta: None,
        }),
    )
    .await;
}

async fn emit_thought(env: &TurnEnv, text: &str) {
    emit_notification(
        env,
        acp::SessionUpdate::AgentThoughtChunk(acp::ContentChunk {
            content: acp::ContentBlock::Text(acp::TextContent {
                annotations: None,
                text: text.to_string(),
                meta: None,
            }),
            meta: None,
        }),
    )
    .await;
}

async fn emit_notification(env: &TurnEnv, update: acp::SessionUpdate) {
    use acp::Client as _;
    let notification = acp::SessionNotification {
        session_id: env.session_id.clone(),
        update,
        meta: None,
    };
    // Best-effort: a dropped client shouldn't fail the whole turn.
    let _ = env.conn.session_notification(notification).await;
}

/// Short argument summary for tool-call titles, e.g. `edit_file(src/main.rs)`.
fn brief_args(args: &serde_json::Value) -> String {
    let keys = ["path", "pattern", "command"];
    for key in keys {
        if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
            let trimmed: String = v.chars().take(40).collect();
            return if v.chars().count() > 40 {
                format!("{trimmed}…")
            } else {
                trimmed
            };
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native::compact;
    use crate::agent::native::provider::{ChunkStream, StopReasonKind, Usage};
    use crate::error::NexError;
    use tokio::sync::mpsc;

    /// Scripted provider: each `stream()` call pops the next scripted turn.
    /// Also records whether each request had tools attached (for wrap-up tests).
    struct ScriptedProvider {
        turns: std::sync::Mutex<std::collections::VecDeque<Vec<Chunk>>>,
        tools_nonempty: std::sync::Arc<std::sync::Mutex<Vec<bool>>>,
    }

    #[async_trait::async_trait]
    impl Provider for ScriptedProvider {
        fn name(&self) -> &str {
            "scripted"
        }
        async fn stream(&self, req: ChatRequest) -> Result<ChunkStream, NexError> {
            self.tools_nonempty
                .lock()
                .unwrap()
                .push(!req.tools.is_empty());
            let (tx, rx) = mpsc::unbounded_channel();
            let turn = self.turns.lock().unwrap().pop_front().unwrap_or_default();
            for chunk in turn {
                let _ = tx.send(chunk);
            }
            Ok(rx)
        }
    }

    /// Recording client: captures notifications and answers permission prompts.
    struct RecClient {
        notifications: Rc<RefCell<Vec<acp::SessionUpdate>>>,
        permission_requests: Rc<RefCell<usize>>,
        deny_all: bool,
    }

    #[async_trait::async_trait(?Send)]
    impl acp::Client for RecClient {
        async fn session_notification(&self, args: acp::SessionNotification) -> acp::Result<()> {
            self.notifications.borrow_mut().push(args.update);
            Ok(())
        }
        async fn request_permission(
            &self,
            _args: acp::RequestPermissionRequest,
        ) -> acp::Result<acp::RequestPermissionResponse> {
            *self.permission_requests.borrow_mut() += 1;
            let option_id = if self.deny_all {
                "reject"
            } else {
                "allow-once"
            };
            Ok(acp::RequestPermissionResponse {
                outcome: acp::RequestPermissionOutcome::Selected {
                    option_id: acp::PermissionOptionId(Arc::from(option_id)),
                },
                meta: None,
            })
        }
        async fn write_text_file(
            &self,
            _args: acp::WriteTextFileRequest,
        ) -> acp::Result<acp::WriteTextFileResponse> {
            Err(acp::Error::method_not_found())
        }
        async fn read_text_file(
            &self,
            _args: acp::ReadTextFileRequest,
        ) -> acp::Result<acp::ReadTextFileResponse> {
            Err(acp::Error::method_not_found())
        }
        async fn ext_method(&self, _args: acp::ExtRequest) -> acp::Result<acp::ExtResponse> {
            Err(acp::Error::method_not_found())
        }
        async fn ext_notification(&self, _args: acp::ExtNotification) -> acp::Result<()> {
            Ok(())
        }
    }

    /// A no-op agent for the opposite end of the test duplex.
    struct NullAgent;
    #[async_trait::async_trait(?Send)]
    impl acp::Agent for NullAgent {
        async fn initialize(
            &self,
            _a: acp::InitializeRequest,
        ) -> acp::Result<acp::InitializeResponse> {
            Err(acp::Error::method_not_found())
        }
        async fn authenticate(
            &self,
            _a: acp::AuthenticateRequest,
        ) -> acp::Result<acp::AuthenticateResponse> {
            Err(acp::Error::method_not_found())
        }
        async fn new_session(
            &self,
            _a: acp::NewSessionRequest,
        ) -> acp::Result<acp::NewSessionResponse> {
            Err(acp::Error::method_not_found())
        }
        async fn prompt(&self, _a: acp::PromptRequest) -> acp::Result<acp::PromptResponse> {
            Err(acp::Error::method_not_found())
        }
        async fn cancel(&self, _a: acp::CancelNotification) -> acp::Result<()> {
            Ok(())
        }
    }

    fn text_chunk(s: &str) -> Chunk {
        Chunk::Text(s.to_string())
    }
    fn done() -> Chunk {
        Chunk::Done {
            stop_reason: StopReasonKind::EndTurn,
            usage: Some(Usage::default()),
        }
    }
    fn max_tokens_done() -> Chunk {
        Chunk::Done {
            stop_reason: StopReasonKind::MaxTokens,
            usage: Some(Usage::default()),
        }
    }

    /// Wires `run_turn`'s `TurnEnv` over the exact duplex setup the real agent
    /// uses: RecClient on the client side, NullAgent on the agent side. The
    /// `AgentSideConnection` handle is what `run_turn` sends through.
    type TurnEnvHarness = (
        TurnEnv,
        Rc<RefCell<Vec<acp::SessionUpdate>>>,
        Rc<RefCell<usize>>,
    );
    fn make_env(
        provider: ScriptedProvider,
        cwd: &std::path::Path,
        deny_all: bool,
    ) -> TurnEnvHarness {
        use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

        let (client_end, agent_end) = tokio::io::duplex(64 * 1024);

        let (agent_read, agent_write) = tokio::io::split(agent_end);
        let (conn, agent_io) = acp::AgentSideConnection::new(
            NullAgent,
            agent_write.compat_write(),
            agent_read.compat(),
            |fut| {
                tokio::task::spawn_local(fut);
            },
        );
        tokio::task::spawn_local(async move {
            let _ = agent_io.await;
        });

        let notifications: Rc<RefCell<Vec<acp::SessionUpdate>>> = Rc::new(RefCell::new(Vec::new()));
        let permission_requests = Rc::new(RefCell::new(0usize));
        let (client_read, client_write) = tokio::io::split(client_end);
        let (_client_conn, client_io) = acp::ClientSideConnection::new(
            RecClient {
                notifications: notifications.clone(),
                permission_requests: permission_requests.clone(),
                deny_all,
            },
            client_write.compat_write(),
            client_read.compat(),
            |fut| {
                tokio::task::spawn_local(fut);
            },
        );
        tokio::task::spawn_local(async move {
            let _ = client_io.await;
        });

        let registry = Rc::new(ToolRegistry::builtins());
        let mode_id = Rc::new(RefCell::new("code".to_string()));
        let env = TurnEnv {
            conn: Arc::new(conn),
            session_id: acp::SessionId(Arc::from("test-session")),
            provider: Arc::new(provider),
            tool_specs: registry.specs(),
            registry,
            model: "test-model".into(),
            reasoning: ReasoningControl::Off,
            max_steps: 5,
            mode_id: mode_id.clone(),
            plan_pending_confirm: Rc::new(Cell::new(false)),
            cancelled: Rc::new(Cell::new(false)),
            auto_allow: Rc::new(RefCell::new(HashSet::new())),
            tool_ctx: ToolCtx {
                cwd: cwd.to_path_buf(),
                bash_timeout: std::time::Duration::from_secs(10),
                path_env: std::env::var_os("PATH").unwrap_or_default(),
                archive_dir: cwd.join(".nex-archive"),
                jobs: Rc::new(RefCell::new(
                    crate::agent::native::tools::jobs::JobTable::default(),
                )),
                harness: None,
                mutations: Rc::new(RefCell::new(Vec::new())),
                mode_id: Some(mode_id),
                memory: crate::agent::native::tools::test_memory_handle(),
            },
            context_window: 0,
            usage: RefCell::new(Usage::default()),
            stats: RefCell::new(stats::ContextStats::new()),
        };
        (env, notifications, permission_requests)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn subagent_restores_parent_goal_and_todos_but_keeps_workspace_memory() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "todo_1".into(),
                                name: "todo_write".into(),
                                arguments: serde_json::json!({
                                    "todos": [{"content": "child todo", "status": "pending"}]
                                }),
                            }),
                            Chunk::ToolCall(NativeToolCall {
                                id: "write_1".into(),
                                name: "write_file".into(),
                                arguments: serde_json::json!({
                                    "path": "child.txt",
                                    "content": "from child"
                                }),
                            }),
                            done(),
                        ],
                        vec![text_chunk("child done"), done()],
                    ])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, _, _) = make_env(provider, tmp.path(), false);
                {
                    let mut memory = env.tool_ctx.memory.borrow_mut();
                    memory.set_goal("parent goal");
                    memory.replace_active_todos(["parent todo".to_string()]);
                }
                let registry = Rc::new(ToolRegistry::subagents());
                let harness = SubagentHarness {
                    conn: env.conn.clone(),
                    parent_session_id: env.session_id.clone(),
                    provider: env.provider.clone(),
                    tool_specs: registry.specs(),
                    registry,
                    model: env.model.clone(),
                    reasoning: env.reasoning,
                    max_sub_steps: 5,
                    concurrency: 1,
                    cwd: tmp.path().to_path_buf(),
                    bash_timeout: Duration::from_secs(10),
                    path_env: std::env::var_os("PATH").unwrap_or_default(),
                    archive_dir: tmp.path().join(".nex-archive"),
                    context_window: 0,
                    cancelled: Rc::new(Cell::new(false)),
                    mode_id: env.mode_id.clone(),
                    mutations: env.tool_ctx.mutations.clone(),
                    memory: env.tool_ctx.memory.clone(),
                };

                assert_eq!(run_subagent(&harness, "child goal").await.unwrap(), "child done");
                let memory = harness.memory.borrow();
                assert_eq!(memory.goal, vec!["parent goal"]);
                assert_eq!(memory.active_todos, vec!["parent todo"]);
                assert!(memory.files_changed.iter().any(|path| path == "child.txt"));
                assert!(!harness.mutations.borrow().is_empty());
            })
            .await;
    }

    /// Multi-round loop: first turn requests a read_file tool call, second
    /// turn produces the final answer.
    #[tokio::test(flavor = "current_thread")]
    async fn loop_runs_tool_then_finishes() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                std::fs::write(tmp.path().join("x.txt"), "hello").unwrap();

                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "call_1".into(),
                                name: "read_file".into(),
                                arguments: serde_json::json!({"path": "x.txt"}),
                            }),
                            done(),
                        ],
                        vec![text_chunk("文件内容是 hello"), done()],
                    ])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, nots, perms) = make_env(provider, tmp.path(), false);
                let mut messages = vec![ChatMessage::system("sys")];
                let stop =
                    run_turn(&env, &mut messages, Content::Text("读一下 x.txt".into())).await;
                assert!(matches!(stop, acp::StopReason::EndTurn));

                // system, working-memory, user, assistant(tool_calls), tool, assistant.
                assert_eq!(messages.len(), 6);
                assert!(messages[1]
                    .content
                    .as_ref()
                    .and_then(Content::as_text)
                    .unwrap()
                    .starts_with(crate::agent::native::memory::MARKER));
                assert_eq!(messages[3].role, "assistant");
                assert!(messages[3].tool_calls.is_some());
                assert_eq!(messages[4].role, "tool");
                assert_eq!(messages[4].tool_call_id.as_deref(), Some("call_1"));
                assert!(messages[4]
                    .content
                    .as_ref()
                    .and_then(Content::as_text)
                    .unwrap()
                    .contains("hello"));
                assert_eq!(
                    messages[5].content.as_ref().and_then(Content::as_text),
                    Some("文件内容是 hello")
                );

                // Read-only tool: no permission prompt, but lifecycle updates streamed.
                assert_eq!(*perms.borrow(), 0);
                // Notifications travel over the duplex pipe asynchronously;
                // wait until the client side has drained them all
                // (1 tool_call + 2 updates + 1 text chunk).
                for _ in 0..200 {
                    if nots.borrow().len() >= 4 {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                let kinds: Vec<&str> = nots
                    .borrow()
                    .iter()
                    .map(|u| match u {
                        acp::SessionUpdate::ToolCall(_) => "tool_call",
                        acp::SessionUpdate::ToolCallUpdate(_) => "tool_update",
                        acp::SessionUpdate::AgentMessageChunk(_) => "text",
                        _ => "other",
                    })
                    .collect();
                assert!(kinds.contains(&"tool_call"));
                assert!(kinds.contains(&"tool_update"));
                assert!(kinds.contains(&"text"));
            })
            .await;
    }

    /// Denied permission becomes a tool error the model can see.
    #[tokio::test(flavor = "current_thread")]
    async fn denied_permission_feeds_error() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "call_w".into(),
                                name: "write_file".into(),
                                arguments: serde_json::json!({"path": "y.txt", "content": "z"}),
                            }),
                            done(),
                        ],
                        vec![text_chunk("done"), done()],
                    ])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, _nots, perms) = make_env(provider, tmp.path(), true);
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("写文件".into())).await;
                assert!(matches!(stop, acp::StopReason::EndTurn));
                // Tool result carries the denial and file wasn't created.
                assert_eq!(*perms.borrow(), 1);
                let tool_msg = messages.iter().find(|m| m.role == "tool").unwrap();
                assert!(tool_msg
                    .content
                    .as_ref()
                    .and_then(Content::as_text)
                    .unwrap()
                    .contains("denied"));
                assert!(!tmp.path().join("y.txt").exists());
            })
            .await;
    }

    /// Cancellation mid-turn stops the loop promptly.
    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_stops_loop() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![vec![
                        text_chunk("hi"),
                        done(),
                    ]])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, _nots, _perms) = make_env(provider, tmp.path(), false);
                env.cancelled.set(true);
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("你好".into())).await;
                assert!(matches!(stop, acp::StopReason::Cancelled));
            })
            .await;
    }

    /// Consecutive read-only calls run as one parallel batch; results come
    /// back paired and in the original call order.
    #[tokio::test(flavor = "current_thread")]
    async fn read_only_batch_keeps_order() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                std::fs::write(tmp.path().join("a.txt"), "A").unwrap();
                std::fs::write(tmp.path().join("b.txt"), "B").unwrap();
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_a".into(),
                                name: "read_file".into(),
                                arguments: serde_json::json!({"path": "a.txt"}),
                            }),
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_b".into(),
                                name: "read_file".into(),
                                arguments: serde_json::json!({"path": "b.txt"}),
                            }),
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_ls".into(),
                                name: "ls".into(),
                                arguments: serde_json::json!({}),
                            }),
                            done(),
                        ],
                        vec![text_chunk("ok"), done()],
                    ])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, _nots, perms) = make_env(provider, tmp.path(), false);
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("读三个".into())).await;
                assert!(matches!(stop, acp::StopReason::EndTurn));
                assert_eq!(*perms.borrow(), 0, "read-only batch must not prompt");

                // system, working-memory, user, assistant(3 calls), 3 tool results, assistant.
                assert_eq!(messages.len(), 8);
                let ids: Vec<_> = messages[4..7]
                    .iter()
                    .map(|m| m.tool_call_id.clone().unwrap())
                    .collect();
                assert_eq!(ids, vec!["c_a", "c_b", "c_ls"]);
                assert!(messages[4]
                    .content
                    .as_ref()
                    .and_then(Content::as_text)
                    .unwrap()
                    .contains('A'));
                assert!(messages[5]
                    .content
                    .as_ref()
                    .and_then(Content::as_text)
                    .unwrap()
                    .contains('B'));
            })
            .await;
    }

    /// Mutating calls run serially and are recorded in the mutation log.
    #[tokio::test(flavor = "current_thread")]
    async fn mutating_calls_are_logged() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_w1".into(),
                                name: "write_file".into(),
                                arguments: serde_json::json!({"path": "n1.txt", "content": "1"}),
                            }),
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_w2".into(),
                                name: "write_file".into(),
                                arguments: serde_json::json!({"path": "n2.txt", "content": "2"}),
                            }),
                            done(),
                        ],
                        vec![text_chunk("done"), done()],
                    ])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, _nots, _perms) = make_env(provider, tmp.path(), false);
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("写两个".into())).await;
                assert!(matches!(stop, acp::StopReason::EndTurn));
                assert!(tmp.path().join("n1.txt").exists());
                assert!(tmp.path().join("n2.txt").exists());
                let log = env.tool_ctx.mutations.borrow();
                assert_eq!(log.len(), 2);
                assert!(log[0].starts_with("write_file"));
                assert!(log[1].contains("n2.txt"));
            })
            .await;
    }

    /// `plan` mode behaves like `ask`: mutating tools are refused without any
    /// permission prompt, and the refusal reaches the model as a tool error.
    #[tokio::test(flavor = "current_thread")]
    async fn plan_mode_refuses_writes() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_w".into(),
                                name: "write_file".into(),
                                arguments: serde_json::json!({"path": "p.txt", "content": "x"}),
                            }),
                            done(),
                        ],
                        vec![text_chunk("plan only"), done()],
                    ])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, _nots, perms) = make_env(provider, tmp.path(), false);
                *env.mode_id.borrow_mut() = "plan".to_string(); // plan mode gating (see mod.rs)
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("改一下".into())).await;
                assert!(matches!(stop, acp::StopReason::EndTurn));
                assert_eq!(*perms.borrow(), 0, "read-only refusal must not prompt");
                let tool_msg = messages.iter().find(|m| m.role == "tool").unwrap();
                assert!(tool_msg
                    .content
                    .as_ref()
                    .and_then(Content::as_text)
                    .unwrap()
                    .contains("只读模式"));
                assert!(!tmp.path().join("p.txt").exists());
            })
            .await;
    }

    /// Model can leave Plan via `switch_mode` (read-only tool); subsequent
    /// writes then follow Code gating, and the client gets CurrentModeUpdate.
    #[tokio::test(flavor = "current_thread")]
    async fn switch_mode_exits_plan_and_emits_update() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_sw".into(),
                                name: "switch_mode".into(),
                                arguments: serde_json::json!({
                                    "mode": "code",
                                    "reason": "user confirmed plan"
                                }),
                            }),
                            done(),
                        ],
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_w".into(),
                                name: "write_file".into(),
                                arguments: serde_json::json!({"path": "out.txt", "content": "ok"}),
                            }),
                            done(),
                        ],
                        vec![text_chunk("done"), done()],
                    ])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, nots, perms) = make_env(provider, tmp.path(), false);
                *env.mode_id.borrow_mut() = "plan".to_string();
                env.plan_pending_confirm.set(true);
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("按方案实现".into())).await;
                assert!(matches!(stop, acp::StopReason::EndTurn));
                assert_eq!(env.mode_id.borrow().as_str(), "code");
                assert!(
                    *perms.borrow() >= 1,
                    "leaving plan for code must request confirmation"
                );
                assert!(!env.plan_pending_confirm.get());
                assert!(tmp.path().join("out.txt").exists());

                for _ in 0..200 {
                    let has = nots
                        .borrow()
                        .iter()
                        .any(|u| matches!(u, acp::SessionUpdate::CurrentModeUpdate(_)));
                    if has {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                let mode_updates: Vec<_> = nots
                    .borrow()
                    .iter()
                    .filter_map(|u| match u {
                        acp::SessionUpdate::CurrentModeUpdate(m) => {
                            Some(m.current_mode_id.0.to_string())
                        }
                        _ => None,
                    })
                    .collect();
                assert!(
                    mode_updates.iter().any(|m| m == "code"),
                    "expected CurrentModeUpdate(code), got {mode_updates:?}"
                );
            })
            .await;
    }

    /// An ask session must not silently enter auto: that would suppress every
    /// later permission prompt.
    #[tokio::test(flavor = "current_thread")]
    async fn ask_to_auto_requires_confirmation() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_auto".into(),
                                name: "switch_mode".into(),
                                arguments: serde_json::json!({ "mode": "auto" }),
                            }),
                            done(),
                        ],
                        vec![text_chunk("staying in ask"), done()],
                    ])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, _nots, perms) = make_env(provider, tmp.path(), true);
                *env.mode_id.borrow_mut() = "ask".to_string();
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("提权".into())).await;
                assert!(matches!(stop, acp::StopReason::EndTurn));
                assert_eq!(env.mode_id.borrow().as_str(), "ask");
                assert!(
                    *perms.borrow() >= 1,
                    "ask→auto must request confirmation"
                );
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ask_to_auto_allowed_switches() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_auto".into(),
                                name: "switch_mode".into(),
                                arguments: serde_json::json!({ "mode": "auto" }),
                            }),
                            done(),
                        ],
                        vec![text_chunk("now auto"), done()],
                    ])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, _nots, perms) = make_env(provider, tmp.path(), false);
                *env.mode_id.borrow_mut() = "ask".to_string();
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("提权".into())).await;
                assert!(matches!(stop, acp::StopReason::EndTurn));
                assert_eq!(env.mode_id.borrow().as_str(), "auto");
                assert!(
                    *perms.borrow() >= 1,
                    "ask→auto must still prompt even when allowed"
                );
            })
            .await;
    }

    /// `plan → ask → code` must still hit the plan gate (not only direct
    /// `plan → code`).
    #[tokio::test(flavor = "current_thread")]
    async fn plan_ask_code_bypass_still_requires_confirm() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_ask".into(),
                                name: "switch_mode".into(),
                                arguments: serde_json::json!({ "mode": "ask" }),
                            }),
                            done(),
                        ],
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_code".into(),
                                name: "switch_mode".into(),
                                arguments: serde_json::json!({ "mode": "code" }),
                            }),
                            done(),
                        ],
                        vec![text_chunk("stuck"), done()],
                    ])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, _nots, perms) = make_env(provider, tmp.path(), true);
                *env.mode_id.borrow_mut() = "plan".to_string();
                env.plan_pending_confirm.set(true);
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("绕过".into())).await;
                assert!(matches!(stop, acp::StopReason::EndTurn));
                // Denied plan confirm keeps the pre-switch mode (`ask`).
                assert_eq!(env.mode_id.borrow().as_str(), "ask");
                assert!(env.plan_pending_confirm.get());
                assert!(
                    *perms.borrow() >= 1,
                    "ask→code after plan must still prompt"
                );
            })
            .await;
    }

    /// `auto` mode: mutating tools execute without hitting the permission
    /// popup at all.
    #[tokio::test(flavor = "current_thread")]
    async fn auto_mode_skips_permission_prompts() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "c_w".into(),
                                name: "write_file".into(),
                                arguments: serde_json::json!({"path": "a.txt", "content": "x"}),
                            }),
                            done(),
                        ],
                        vec![text_chunk("done"), done()],
                    ])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, _nots, perms) = make_env(provider, tmp.path(), true);
                *env.mode_id.borrow_mut() = "auto".to_string(); // auto mode gating (see mod.rs)
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("写文件".into())).await;
                assert!(matches!(stop, acp::StopReason::EndTurn));
                assert_eq!(*perms.borrow(), 0, "auto mode must never prompt");
                // deny_all would have refused a prompt; the file existing proves
                // the tool ran without one.
                assert!(tmp.path().join("a.txt").exists());
            })
            .await;
    }

    /// When `max_steps` is hit, run one final text-only turn with the OpenCode
    /// wrap-up prompt instead of hard-stopping mid-task.
    #[tokio::test(flavor = "current_thread")]
    async fn max_steps_triggers_opencode_style_wrap_up() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let tools_log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: "c1".into(),
                                name: "write_file".into(),
                                arguments: serde_json::json!({"path": "a.txt", "content": "x"}),
                            }),
                            done(),
                        ],
                        // Wrap-up turn: text only.
                        vec![
                            text_chunk(
                                "Maximum steps reached. Done: wrote a.txt. Remaining: tests. Next: run cargo test.",
                            ),
                            done(),
                        ],
                    ])),
                    tools_nonempty: tools_log.clone(),
                };
                let (mut env, nots, _perms) = make_env(provider, tmp.path(), true);
                *env.mode_id.borrow_mut() = "auto".to_string();
                env.max_steps = 1;
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("写文件".into())).await;
                assert!(matches!(stop, acp::StopReason::EndTurn));
                assert!(tmp.path().join("a.txt").exists());
                assert_eq!(
                    *tools_log.lock().unwrap(),
                    vec![true, false],
                    "first call has tools; wrap-up must disable tools"
                );

                // Transcript includes the wrap-up prompt and the summary reply.
                let wrap = messages.iter().find(|m| {
                    m.role == "user"
                        && m.content
                            .as_ref()
                            .and_then(Content::as_text)
                            .is_some_and(|t| t.contains("MAXIMUM STEPS REACHED"))
                });
                assert!(wrap.is_some(), "max-steps prompt must be injected");
                let last = messages.last().expect("assistant wrap-up");
                assert_eq!(last.role, "assistant");
                assert!(
                    last.content
                        .as_ref()
                        .and_then(Content::as_text)
                        .unwrap()
                        .contains("Maximum steps reached"),
                );

                // UI must not show the old hard-stop notice.
                let joined: String = nots
                    .borrow()
                    .iter()
                    .filter_map(|u| match u {
                        acp::SessionUpdate::AgentMessageChunk(c) => match &c.content {
                            acp::ContentBlock::Text(t) => Some(t.text.as_str()),
                            _ => None,
                        },
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                assert!(
                    !joined.contains("已达到最大步数限制"),
                    "must not emit the old hard-stop banner"
                );
            })
            .await;
    }

    /// A provider `finish_reason=length` must surface as MaxTokens and must
    /// never execute tool calls whose JSON may have been cut off mid-stream.
    #[tokio::test(flavor = "current_thread")]
    async fn max_tokens_stops_without_executing_partial_tool_calls() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(vec![vec![
                        text_chunk("正在处理，但回复被截断"),
                        Chunk::ToolCall(NativeToolCall {
                            id: "cut-off-call".into(),
                            name: "write_file".into(),
                            arguments: serde_json::json!({"path": "must-not-exist.txt", "content": "x"}),
                        }),
                        max_tokens_done(),
                    ]])),
                    tools_nonempty: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                };
                let (env, _nots, perms) = make_env(provider, tmp.path(), false);
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("写文件".into())).await;
                assert!(matches!(stop, acp::StopReason::MaxTokens));
                assert_eq!(*perms.borrow(), 0, "truncated call must not prompt");
                assert!(!tmp.path().join("must-not-exist.txt").exists());
                assert!(messages
                    .last()
                    .and_then(|m| m.content.as_ref())
                    .and_then(Content::as_text)
                    .is_some_and(|text| text.contains("token 限制")));
            })
            .await;
    }

    /// Repeating a successful identical tool call is still a loop. The old
    /// lease only counted failures, so a model could read the same file forever
    /// when `maxSteps` was unbounded.
    #[tokio::test(flavor = "current_thread")]
    async fn repeated_successful_tool_rounds_hit_progress_lease() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                std::fs::write(tmp.path().join("same.txt"), "unchanged").unwrap();
                let turns: Vec<Vec<Chunk>> = (0..=LEASE_PAUSE_ROUNDS)
                    .map(|i| {
                        vec![
                            Chunk::ToolCall(NativeToolCall {
                                id: format!("repeat-{i}"),
                                name: "read_file".into(),
                                arguments: serde_json::json!({"path": "same.txt"}),
                            }),
                            done(),
                        ]
                    })
                    .collect();
                let tools_log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
                let provider = ScriptedProvider {
                    turns: std::sync::Mutex::new(std::collections::VecDeque::from(turns)),
                    tools_nonempty: tools_log.clone(),
                };
                let (mut env, _nots, _perms) = make_env(provider, tmp.path(), false);
                env.max_steps = 100;
                let mut messages = vec![ChatMessage::system("sys")];
                let stop = run_turn(&env, &mut messages, Content::Text("反复读取".into())).await;
                assert!(matches!(stop, acp::StopReason::EndTurn));
                assert_eq!(
                    tools_log.lock().unwrap().len(),
                    (LEASE_PAUSE_ROUNDS + 1) as usize,
                    "progress lease should stop before an unbounded loop"
                );
            })
            .await;
    }

    /// `context_window` is threaded from the parent session into the
    /// subagent's `TurnEnv`. With `context_window = 0` the subagent
    /// transcript is left untouched (legacy behaviour preserved); with a
    /// real window an over-budget transcript is compacted.
    #[tokio::test(flavor = "current_thread")]
    async fn subagent_compaction_respects_context_window() {
        // Build an over-budget transcript: many heavy tool results after
        // the system prompt. Compact should snip them when `context_window>0`,
        // and leave them alone when it is `0` (the legacy sentinel).
        let mut msgs = vec![ChatMessage::system("sys")];
        for i in 0..30 {
            msgs.push(ChatMessage::user(format!("user {i} {}", "u".repeat(200))));
            msgs.push(ChatMessage::tool_result(
                format!("id{i}"),
                format!("payload-{i}-{}", "z".repeat(8000)),
            ));
        }
        let tmp = tempfile::tempdir().unwrap();

        // Disabled window: transcript unchanged.
        let mut disabled = msgs.clone();
        let before = compact::estimate_tokens(&disabled);
        budget::enforce(
            &mut disabled,
            budget::ContextBudget {
                model_window: 0,
                reserved_response: 0,
                safety_margin: 0,
                prompt_budget: 0,
            },
            tmp.path(),
        );
        assert_eq!(compact::estimate_tokens(&disabled), before);

        // Active window: the loop walks Snip -> Compact -> Force and bails
        // on no-progress. For a transcript that is *only* user + tool
        // messages the Snip tier is the only tier that can save anything;
        // we just need to verify the loop ran at least once.
        let mut active = msgs.clone();
        let budget = budget::resolve(16_384, 4096, 2048);
        assert!(
            compact::estimate_tokens(&active) > budget.prompt_budget,
            "fixture must actually exceed the budget"
        );
        let outcome = budget::enforce(&mut active, budget, tmp.path());
        assert!(
            outcome.passes >= 1,
            "subagent with context_window>0 must compact"
        );
        assert!(
            compact::estimate_tokens(&active) < before,
            "active window must produce a smaller transcript"
        );
    }

    #[test]
    fn bash_always_allow_is_keyed_by_command_prefix() {
        assert_eq!(
            permission_allow_key("bash", &serde_json::json!({"command": "git status"})),
            "bash:git"
        );
        assert_eq!(
            permission_allow_key("write_file", &serde_json::json!({"path": "a.txt"})),
            "write_file"
        );
        assert_ne!(
            permission_allow_key("bash", &serde_json::json!({"command": "git status"})),
            permission_allow_key("bash", &serde_json::json!({"command": "rm -rf /"}))
        );
    }
}
