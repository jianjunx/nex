export type ThreadEntryKind = "user_message" | "assistant_message" | "tool_call" | "completed_plan";

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
  requestId?: string;
}

export interface ToolCallContentBlock {
  type: "text" | "diff";
  text?: string;
  path?: string;
  oldText?: string;
  newText?: string;
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

export interface UserMessageEntry extends ThreadEntryBase {
  kind: "user_message";
  text: string;
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
  options?: ToolPermissionOption[];
  permissionRequestId?: string;
}

export interface CompletedPlanEntry extends ThreadEntryBase {
  kind: "completed_plan";
  entries: PlanEntry[];
}

export type ThreadEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolCallEntry
  | CompletedPlanEntry;

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
}

export interface SessionConfigOption {
  id: string;
  name: string;
  currentValueId: string;
  options: { id: string; name: string }[];
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
}
