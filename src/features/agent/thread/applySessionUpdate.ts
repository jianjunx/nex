import type {
  AssistantMessageEntry,
  PlanEntry,
  SessionMeta,
  ThreadEntry,
  ToolCallContentBlock,
  ToolCallEntry,
  ToolCallStatus,
} from "./types";

function contentBlockText(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const c = content as Record<string, unknown>;
  if (c.type === "text" && typeof c.text === "string") return c.text;
  if (typeof c.text === "string") return c.text;
  return null;
}

function mapToolStatus(raw: unknown): ToolCallStatus {
  if (typeof raw !== "string") return "pending";
  switch (raw) {
    case "pending":
    case "in_progress":
    case "completed":
    case "failed":
      return raw;
    default:
      return "pending";
  }
}

function mapContentBlock(content: unknown): ToolCallContentBlock | null {
  if (!content || typeof content !== "object") return null;
  const c = content as Record<string, unknown>;
  if (c.type === "image") {
    const data = typeof c.data === "string" ? c.data : null;
    if (!data) return null;
    return {
      type: "image",
      data,
      mimeType:
        typeof c.mimeType === "string"
          ? c.mimeType
          : typeof c.mime_type === "string"
            ? c.mime_type
            : "image/png",
      path: typeof c.uri === "string" ? c.uri : undefined,
    };
  }
  const text = contentBlockText(content);
  if (text) return { type: "text", text };
  return null;
}

function mapToolContent(raw: unknown): ToolCallContentBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCallContentBlock[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.type === "diff") {
      out.push({
        type: "diff",
        path: typeof o.path === "string" ? o.path : undefined,
        oldText: typeof o.oldText === "string" ? o.oldText : typeof o.old_text === "string" ? o.old_text : undefined,
        newText: typeof o.newText === "string" ? o.newText : typeof o.new_text === "string" ? o.new_text : undefined,
      });
      continue;
    }
    if (o.type === "terminal") {
      const text =
        typeof o.output === "string"
          ? o.output
          : typeof o.data === "string"
            ? o.data
            : contentBlockText(o) ?? "";
      out.push({
        type: "terminal",
        text,
        terminalId:
          typeof o.terminalId === "string"
            ? o.terminalId
            : typeof o.terminal_id === "string"
              ? o.terminal_id
              : undefined,
      });
      continue;
    }
    if (o.type === "content" && o.content) {
      const mapped = mapContentBlock(o.content);
      if (mapped) out.push(mapped);
      continue;
    }
    if (o.type === "image") {
      const mapped = mapContentBlock(o);
      if (mapped) out.push(mapped);
      continue;
    }
    const text = contentBlockText(o);
    if (text) out.push({ type: "text", text });
  }
  return out;
}

/** Pretty-print structured tool input for AskUserQuestion-style payloads. */
export function formatToolRawInput(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string") return raw.trim() ? raw : null;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function mapPlanEntries(raw: unknown): PlanEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const entries = (raw as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      content: typeof e.content === "string" ? e.content : "",
      priority: typeof e.priority === "string" ? e.priority : "medium",
      status: typeof e.status === "string" ? e.status : "pending",
    }));
}

/** Only continue the trailing assistant bubble; anything after it (tools, user, …) starts a new one. */
function lastAssistant(entries: ThreadEntry[]): AssistantMessageEntry | null {
  const last = entries[entries.length - 1];
  return last?.kind === "assistant_message" ? last : null;
}

function findTool(entries: ThreadEntry[], toolCallId: string): ToolCallEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "tool_call" && e.toolCallId === toolCallId) return e;
  }
  return null;
}

function appendAssistantChunk(
  entries: ThreadEntry[],
  isThought: boolean,
  text: string,
  now: number,
): void {
  if (!text) return;
  const last = lastAssistant(entries);
  if (last) {
    const chunk = last.chunks[last.chunks.length - 1];
    if (chunk && chunk.type === (isThought ? "thought" : "message")) {
      chunk.text += text;
      return;
    }
    last.chunks.push(isThought ? { type: "thought", text } : { type: "message", text });
    return;
  }
  entries.push({
    id: crypto.randomUUID(),
    kind: "assistant_message",
    timestamp: now,
    chunks: [isThought ? { type: "thought", text } : { type: "message", text }],
  });
}

function upsertToolCall(entries: ThreadEntry[], update: Record<string, unknown>, now: number): void {
  const toolCallId =
    typeof update.toolCallId === "string"
      ? update.toolCallId
      : typeof update.id === "string"
        ? update.id
        : null;
  if (!toolCallId) return;

  const existing = findTool(entries, toolCallId);
  const title = typeof update.title === "string" ? update.title : existing?.title ?? "Tool call";
  const toolKind =
    typeof update.kind === "string" ? update.kind : existing?.toolKind ?? "other";
  const status = update.status !== undefined ? mapToolStatus(update.status) : existing?.status ?? "pending";
  const content =
    update.content !== undefined ? mapToolContent(update.content) : existing?.content ?? [];
  const rawInput =
    update.rawInput !== undefined
      ? update.rawInput
      : update.raw_input !== undefined
        ? update.raw_input
        : existing?.rawInput;

  if (existing) {
    existing.title = title;
    existing.toolKind = toolKind;
    if (existing.status !== "waiting_for_confirmation" || status !== "pending") {
      existing.status = status;
    }
    existing.content = content;
    if (rawInput !== undefined) existing.rawInput = rawInput;
    return;
  }

  entries.push({
    id: crypto.randomUUID(),
    kind: "tool_call",
    timestamp: now,
    toolCallId,
    title,
    toolKind,
    status,
    content,
    ...(rawInput !== undefined ? { rawInput } : {}),
  });
}

/**
 * Ensure the tool card for a permission request exists and is waiting.
 * ACP may send `session/request_permission` with full toolCall fields before
 * (or instead of) a separate tool_call sessionUpdate — Claude AskUserQuestion
 * relies on this path to surface the question text.
 */
export function applyPermissionRequestToEntries(
  entries: ThreadEntry[],
  payload: {
    requestId: string;
    toolCallId?: string | null;
    toolTitle?: string | null;
    toolKind?: string | null;
    toolContent?: unknown;
    toolRawInput?: unknown;
    options: { optionId: string; label: string; kind?: string | null }[];
  },
): boolean {
  const toolCallId = payload.toolCallId;
  if (!toolCallId) return false;

  const options = payload.options.map((o) => ({ ...o, requestId: payload.requestId }));
  const content =
    payload.toolContent !== undefined && payload.toolContent !== null
      ? mapToolContent(payload.toolContent)
      : null;
  const existing = findTool(entries, toolCallId);

  if (existing) {
    if (payload.toolTitle) existing.title = payload.toolTitle;
    if (payload.toolKind) existing.toolKind = payload.toolKind;
    if (content && content.length > 0) existing.content = content;
    if (payload.toolRawInput !== undefined && payload.toolRawInput !== null) {
      existing.rawInput = payload.toolRawInput;
    }
    existing.status = "waiting_for_confirmation";
    existing.permissionRequestId = payload.requestId;
    existing.options = options;
    return true;
  }

  entries.push({
    id: crypto.randomUUID(),
    kind: "tool_call",
    timestamp: Date.now(),
    toolCallId,
    title: payload.toolTitle?.trim() || "Permission required",
    toolKind: payload.toolKind?.trim() || "other",
    status: "waiting_for_confirmation",
    content: content ?? [],
    ...(payload.toolRawInput != null ? { rawInput: payload.toolRawInput } : {}),
    permissionRequestId: payload.requestId,
    options,
  });
  return true;
}

export function emptySessionMeta(): SessionMeta {
  return {
    modes: [],
    currentModeId: null,
    models: [],
    currentModelId: null,
    configOptions: [],
    availableCommands: [],
    plan: null,
    contextUsage: null,
  };
}

export interface ApplyResult {
  entriesChanged: boolean;
  metaChanged: boolean;
  completedPlanSnapshot: PlanEntry[] | null;
}

/**
 * Applies one ACP SessionUpdate (JSON) onto thread entries + session meta.
 * Mutates `entries` / `meta` in place (Immer-friendly).
 */
export function applySessionUpdate(
  entries: ThreadEntry[],
  meta: SessionMeta,
  update: unknown,
): ApplyResult {
  const result: ApplyResult = {
    entriesChanged: false,
    metaChanged: false,
    completedPlanSnapshot: null,
  };
  if (!update || typeof update !== "object") return result;
  const u = update as Record<string, unknown>;
  const kind = u.sessionUpdate;
  const now = Date.now();

  switch (kind) {
    case "user_message_chunk":
      // Optimistic user messages already exist; ignore agent echoes.
      return result;

    case "agent_message_chunk": {
      const text = contentBlockText(u.content);
      if (text) {
        appendAssistantChunk(entries, false, text, now);
        result.entriesChanged = true;
      }
      return result;
    }

    case "agent_thought_chunk": {
      const text = contentBlockText(u.content);
      if (text) {
        appendAssistantChunk(entries, true, text, now);
        result.entriesChanged = true;
      }
      return result;
    }

    case "tool_call":
      upsertToolCall(entries, u, now);
      result.entriesChanged = true;
      return result;

    case "tool_call_update":
      upsertToolCall(entries, u, now);
      result.entriesChanged = true;
      return result;

    case "plan": {
      const plan = mapPlanEntries(u);
      meta.plan = plan.length > 0 ? plan : null;
      result.metaChanged = true;
      if (plan.length > 0 && plan.every((p) => p.status === "completed")) {
        result.completedPlanSnapshot = plan;
        meta.plan = null;
      }
      return result;
    }

    case "available_commands_update": {
      const cmds = Array.isArray(u.availableCommands)
        ? u.availableCommands
        : Array.isArray(u.available_commands)
          ? u.available_commands
          : [];
      meta.availableCommands = cmds
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({
          name: typeof c.name === "string" ? c.name : "",
          description: typeof c.description === "string" ? c.description : "",
          inputHint:
            c.input && typeof c.input === "object" && typeof (c.input as { hint?: unknown }).hint === "string"
              ? (c.input as { hint: string }).hint
              : undefined,
        }))
        .filter((c) => c.name);
      result.metaChanged = true;
      return result;
    }

    case "current_mode_update": {
      const id =
        typeof u.currentModeId === "string"
          ? u.currentModeId
          : typeof u.current_mode_id === "string"
            ? u.current_mode_id
            : null;
      if (id) {
        meta.currentModeId = id;
        result.metaChanged = true;
      }
      return result;
    }

    case "config_option_update": {
      // Forward-compatible: agents on newer ACP may send this.
      const options = Array.isArray(u.configOptions)
        ? u.configOptions
        : Array.isArray(u.config_options)
          ? u.config_options
          : [];
      meta.configOptions = options
        .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
        .map((o) => ({
          id: typeof o.id === "string" ? o.id : "",
          name: typeof o.name === "string" ? o.name : "",
          category: typeof o.category === "string" ? o.category : undefined,
          currentValueId:
            typeof o.currentValueId === "string"
              ? o.currentValueId
              : typeof o.current_value_id === "string"
                ? o.current_value_id
                : typeof o.currentValue === "string"
                  ? o.currentValue
                  : typeof o.current_value === "string"
                    ? o.current_value
                    : "",
          options: Array.isArray(o.options)
            ? o.options
                .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
                .map((x) => ({
                  id:
                    typeof x.id === "string"
                      ? x.id
                      : typeof x.value === "string"
                        ? x.value
                        : "",
                  name: typeof x.name === "string" ? x.name : "",
                }))
            : [],
        }))
        .filter((o) => o.id);
      // Prefer configOptions as source of truth for mode/model current values.
      const modeOpt = meta.configOptions.find((o) => o.id === "mode" || o.category === "mode");
      if (modeOpt?.currentValueId) meta.currentModeId = modeOpt.currentValueId;
      const modelOpt = meta.configOptions.find((o) => o.id === "model" || o.category === "model");
      if (modelOpt?.currentValueId) meta.currentModelId = modelOpt.currentValueId;
      result.metaChanged = true;
      return result;
    }

    case "session_info_update": {
      // 上下文用量上报（新版 ACP；旧 schema 不识别，后端按原始 JSON 透传）。
      const usage = u.usage;
      if (usage && typeof usage === "object") {
        const us = usage as Record<string, unknown>;
        const size =
          us.size && typeof us.size === "object"
            ? (us.size as Record<string, unknown>)
            : null;
        const used = size && typeof size.used === "number" ? size.used : null;
        const total = size && typeof size.total === "number" ? size.total : null;
        const tokens = Array.isArray(us.tokens)
          ? us.tokens
              .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
              .map((t) => ({
                type: typeof t.type === "string" ? t.type : "",
                name: typeof t.name === "string" ? t.name : undefined,
                value: typeof t.value === "number" ? t.value : 0,
              }))
              .filter((t) => t.type)
          : [];
        if (used != null || tokens.length > 0) {
          meta.contextUsage = {
            used: used ?? tokens.reduce((acc, t) => acc + t.value, 0),
            total: total ?? 0,
            tokens,
          };
          result.metaChanged = true;
        }
      }
      return result;
    }

    default:
      return result;
  }
}
