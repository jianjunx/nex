import type { AskQuestionAnswerPayload, AskQuestionItemPayload } from "../../../bridge/events";

export type ThreadEntryKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "completed_plan"
  | "plan_approval"
  | "ask_question"
  | "turn_summary";

export type AssistantChunk =
  | { type: "message"; text: string }
  | { type: "thought"; text: string };

export type ToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "waiting_for_confirmation";

export interface ToolPermissionOption {
  optionId: string;
  label: string;
  kind?: string | null;
  requestId?: string;
}

export interface ToolCallContentBlock {
  type: "text" | "diff" | "image" | "terminal";
  text?: string;
  path?: string;
  oldText?: string;
  newText?: string;
  /** base64 payload for `image` blocks */
  data?: string;
  mimeType?: string;
  /** terminal exit / output metadata when present */
  terminalId?: string;
}

export interface PlanEntry {
  content: string;
  priority: string;
  status: "pending" | "in_progress" | "completed" | string;
}

export interface ThreadEntryBase {
  id: string;
  timestamp: number;
}

export interface UserMessageImage {
  mimeType: string;
  data: string;
}

export interface UserMessageEntry extends ThreadEntryBase {
  kind: "user_message";
  text: string;
  images?: UserMessageImage[];
  /** Number of images that were sent transiently but not retained/persisted. */
  imageCount?: number;
}

export interface AssistantMessageEntry extends ThreadEntryBase {
  kind: "assistant_message";
  chunks: AssistantChunk[];
}

export interface ToolCallEntry extends ThreadEntryBase {
  kind: "tool_call";
  toolCallId: string;
  title: string;
  toolKind: string;
  status: ToolCallStatus;
  content: ToolCallContentBlock[];
  /** Structured tool args (e.g. AskUserQuestion payload) when content is empty. */
  rawInput?: unknown;
  options?: ToolPermissionOption[];
  permissionRequestId?: string;
}

export interface CompletedPlanEntry extends ThreadEntryBase {
  kind: "completed_plan";
  entries: PlanEntry[];
  /** Whether every step finished as completed before the plan left the top bar. */
  allCompleted?: boolean;
}

/** Cursor `cursor/create_plan` — inline approval card (replaces modal). */
export interface PlanApprovalEntry extends ThreadEntryBase {
  kind: "plan_approval";
  requestId: string;
  name?: string;
  overview?: string;
  plan: string;
  todos: { id: string; content: string; status: string }[];
  status: "pending" | "accepted" | "rejected" | "cancelled";
}

/** Cursor `cursor/ask_question` / Claude AskUserQuestion — inline card. */
export interface AskQuestionEntry extends ThreadEntryBase {
  kind: "ask_question";
  requestId: string;
  title?: string;
  questions: AskQuestionItemPayload[];
  status: "pending" | "answered" | "skipped" | "cancelled";
  answers?: AskQuestionAnswerPayload[];
}

/**
 * 一轮对话正常结束后追加的用量摘要（耗时 / token / 模型）。
 * token 仅在 agent 上报整轮用量时才有（NexAgent）；外部 ACP agent 缺省。
 */
export interface TurnSummaryEntry extends ThreadEntryBase {
  kind: "turn_summary";
  /** 从发出 prompt 到结束的墙钟耗时（含等待用户确认的时间）。 */
  durationMs: number;
  /** 本轮使用的模型展示名（取不到时为模型 id）。 */
  model?: string;
  /** 本轮累计输入 token（含多次 provider 请求）。 */
  promptTokens?: number;
  /** 本轮累计输出 token。 */
  completionTokens?: number;
  /** 本轮累计缓存命中 token（输入 token 的子集）。 */
  cacheHitTokens?: number;
}

export type ThreadEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolCallEntry
  | CompletedPlanEntry
  | PlanApprovalEntry
  | AskQuestionEntry
  | TurnSummaryEntry;

export interface AvailableCommand {
  name: string;
  description: string;
  inputHint?: string;
}

export interface SessionModeOption {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModelOption {
  id: string;
  name: string;
  description?: string;
  /** When known (NexAgent), whether the model accepts image inputs. */
  vision?: boolean;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  category?: string;
  currentValueId: string;
  options: { id: string; name: string }[];
}

/** 单条 token 用量（ACP session_info_update.usage.tokens）。 */
export interface ContextTokenUsage {
  /** 如 "input" / "output"，部分 agent 附带 cache 等细分项。 */
  type: string;
  name?: string;
  value: number;
}

/** 上下文窗口用量（ACP session_info_update.usage.size + tokens）。 */
export interface ContextUsage {
  used: number;
  total: number;
  tokens: ContextTokenUsage[];
}

export interface SessionMeta {
  modes: SessionModeOption[];
  currentModeId: string | null;
  models: SessionModelOption[];
  currentModelId: string | null;
  /** Generic config options (effort etc.) when agents expose them. */
  configOptions: SessionConfigOption[];
  availableCommands: AvailableCommand[];
  plan: PlanEntry[] | null;
  /** 上下文窗口用量；agent 未上报时为 null。 */
  contextUsage: ContextUsage | null;
}
