import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { COMMANDS } from "./commands";
import {
  EVENTS,
  type AgentAskQuestionRequestPayload,
  type AgentNotificationPayload,
  type AgentPermissionRequestPayload,
  type AgentPlanApprovalRequestPayload,
  type AskQuestionAnswerPayload,
  type TerminalOutputPayload,
  type TerminalExitedPayload,
  type FsChangedPayload,
  type GitStatusChangedPayload,
  type GitCredentialRequestPayload,
  type UpdateDownloadProgressPayload,
} from "./events";

// --- Projects ---
export interface Project {
  id: string;
  name: string;
  path: string;
  created_at: number;
  last_opened: number;
}

export async function projectOpen(path: string): Promise<Project> {
  return invoke(COMMANDS.PROJECT_OPEN, { path });
}

export async function projectList(): Promise<Project[]> {
  return invoke(COMMANDS.PROJECT_LIST);
}

/** Bump last_opened for activity-ordered project switcher. */
export async function projectTouch(id: string): Promise<number> {
  return invoke(COMMANDS.PROJECT_TOUCH, { id });
}

// --- Conversations ---
export interface Conversation {
  id: string;
  project_id: string;
  title: string;
  agent_type: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_summary: string | null;
  timestamp: number;
  sequence: number;
}

export interface ThreadEntryPayloadDto {
  kind: string;
  sequence: number;
  timestamp: number;
  /** Full ThreadEntry payload serialized as JSON. */
  payload: unknown;
}

export async function conversationCreate(projectId: string, agentType: string): Promise<Conversation> {
  return invoke(COMMANDS.CONVERSATION_CREATE, { projectId, agentType });
}

export async function conversationList(projectId: string): Promise<Conversation[]> {
  return invoke(COMMANDS.CONVERSATION_LIST, { projectId });
}

export async function conversationGetMessages(conversationId: string, limit = 50, offset = 0): Promise<Message[]> {
  return invoke(COMMANDS.CONVERSATION_GET_MESSAGES, { conversationId, limit, offset });
}

export async function conversationUpdateTitle(conversationId: string, title: string): Promise<void> {
  return invoke(COMMANDS.CONVERSATION_UPDATE_TITLE, { conversationId, title });
}

export async function conversationGetThreadEntries(conversationId: string): Promise<ThreadEntryPayloadDto[]> {
  return invoke(COMMANDS.CONVERSATION_GET_THREAD_ENTRIES, { conversationId });
}

export async function conversationReplaceThreadEntries(
  conversationId: string,
  entries: ThreadEntryPayloadDto[],
): Promise<void> {
  return invoke(COMMANDS.CONVERSATION_REPLACE_THREAD_ENTRIES, {
    conversationId,
    entries,
  });
}

export async function conversationAppendMessage(
  conversationId: string,
  role: string,
  content: string,
  toolSummary?: string | null,
): Promise<Message> {
  return invoke(COMMANDS.CONVERSATION_APPEND_MESSAGE, {
    conversationId,
    role,
    content,
    toolSummary: toolSummary ?? null,
  });
}

// --- Agent (open ACP registry + custom servers) ---
/** One row in the New-Conversation agent dropdown. */
export interface ServerDescriptor {
  id: string;
  name: string;
  /** Latest version published in the registry. */
  version: string;
  /** Version currently cached on disk, if any. Compared against `version`
   * to render an "update available" badge in the UI. Omitted entirely for
   * custom servers (which have no registry version). */
  installedVersion?: string;
  description: string;
  icon: string | null;
  kind: "registry" | "custom" | "native";
}

/** A user-defined ACP server (persisted on the Rust side). */
export interface CustomServer {
  id: string;
  name: string;
  command: string;
  env: Record<string, string>;
}

/** Which agent to start a session against; serialized to Rust's `SessionTarget`. */
export type SessionTarget =
  | { type: "registry"; id: string }
  | { type: "custom"; id: string }
  | { type: "native" };

/**
 * Config of the built-in native agent (`nex-agent.json`), camelCase DTO.
 * `reasoningSupport` records whether the model accepts `reasoning_effort`:
 * `unknown` (not verified), `yes` (heuristic match), `no` (runtime rejection).
 */
export interface NativeAgentModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}

export interface NativeAgentModel {
  id: string;
  reasoningSupport: "unknown" | "yes" | "no";
  capabilities: NativeAgentModelCapabilities;
  /** Composer-selectable reasoning effort ids for this model. */
  reasoningLevels: string[];
}

export interface NativeAgentProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: NativeAgentModel[];
}

export interface NativeAgentConfig {
  providers: NativeAgentProvider[];
  /** Composite `<providerId>/<modelId>` used for fresh sessions. */
  defaultModel?: string | null;
  agent: {
    maxSteps: number;
    contextWindow: number;
    bashTimeoutSecs: number;
    maxSubagentConcurrency: number;
  };
  disabledSkills?: string[];
  disabledMcpServers?: string[];
}

export interface NativeMcpServerInfo {
  name: string;
  command?: string | null;
  args: string[];
  env: Record<string, string>;
  url?: string | null;
  enabled: boolean;
  source: string;
}

export interface NativeSkillInfo {
  name: string;
  description: string;
  enabled: boolean;
  source: "builtin" | "user" | string;
}

export interface NativeMcpUpsert {
  name: string;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
}

export async function agentListServers(): Promise<ServerDescriptor[]> {
  return invoke(COMMANDS.AGENT_LIST_SERVERS);
}

export async function agentListAllServers(): Promise<ServerDescriptor[]> {
  return invoke(COMMANDS.AGENT_LIST_ALL_SERVERS);
}

export async function agentRefreshRegistry(): Promise<void> {
  return invoke(COMMANDS.AGENT_REFRESH_REGISTRY);
}

export interface SessionModeDto {
  id: string;
  name: string;
  description?: string | null;
}

export interface SessionModesDto {
  currentModeId: string;
  availableModes: SessionModeDto[];
}

export interface SessionModelDto {
  id: string;
  name: string;
  description?: string | null;
}

export interface SessionModelsDto {
  currentModelId: string;
  availableModels: SessionModelDto[];
}

export interface SessionConfigValueDto {
  id: string;
  name: string;
}

export interface SessionConfigOptionDto {
  id: string;
  name: string;
  category?: string | null;
  currentValueId: string;
  options: SessionConfigValueDto[];
}

export interface CreateSessionResult {
  sessionId: string;
  modes?: SessionModesDto | null;
  models?: SessionModelsDto | null;
  configOptions?: SessionConfigOptionDto[] | null;
}

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime_type: string; uri?: string | null }
  | { type: "resource"; uri: string; mime_type?: string | null; text: string }
  | { type: "resource_link"; uri: string; name: string; mime_type?: string | null };

export async function agentCreateSession(
  conversationId: string,
  target: SessionTarget,
  cwd: string,
): Promise<CreateSessionResult> {
  return invoke(COMMANDS.AGENT_CREATE_SESSION, { conversationId, target, cwd });
}

export async function agentSendPrompt(sessionId: string, blocks: PromptBlock[]): Promise<void> {
  return invoke(COMMANDS.AGENT_SEND_PROMPT, { sessionId, blocks });
}

export async function agentSetSessionMode(sessionId: string, modeId: string): Promise<void> {
  return invoke(COMMANDS.AGENT_SET_SESSION_MODE, { sessionId, modeId });
}

export async function agentSetSessionModel(
  sessionId: string,
  modelId: string,
): Promise<SessionConfigOptionDto[] | null> {
  return invoke(COMMANDS.AGENT_SET_SESSION_MODEL, { sessionId, modelId });
}

export async function agentSetSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string,
): Promise<SessionConfigOptionDto[] | null> {
  return invoke(COMMANDS.AGENT_SET_SESSION_CONFIG_OPTION, { sessionId, configId, value });
}

export async function agentCancel(sessionId: string): Promise<void> {
  return invoke(COMMANDS.AGENT_CANCEL, { sessionId });
}

export async function agentRespondPermission(requestId: string, optionId: string | null): Promise<void> {
  return invoke(COMMANDS.AGENT_RESPOND_PERMISSION, { requestId, optionId });
}

export async function agentRespondPlan(
  requestId: string,
  outcome: "accepted" | "rejected" | "cancelled",
  reason?: string | null,
): Promise<void> {
  return invoke(COMMANDS.AGENT_RESPOND_PLAN, { requestId, outcome, reason: reason ?? null });
}

export async function agentRespondAskQuestion(
  requestId: string,
  outcome: "answered" | "skipped" | "cancelled",
  answers?: AskQuestionAnswerPayload[] | null,
  reason?: string | null,
): Promise<void> {
  return invoke(COMMANDS.AGENT_RESPOND_ASK_QUESTION, {
    requestId,
    outcome,
    answers: answers ?? null,
    reason: reason ?? null,
  });
}

export async function agentCloseSession(sessionId: string): Promise<void> {
  return invoke(COMMANDS.AGENT_CLOSE_SESSION, { sessionId });
}

export async function agentCustomUpsert(server: CustomServer): Promise<void> {
  return invoke(COMMANDS.AGENT_CUSTOM_UPSERT, { server });
}

export async function agentCustomDelete(id: string): Promise<void> {
  return invoke(COMMANDS.AGENT_CUSTOM_DELETE, { id });
}

export async function nativeAgentGetConfig(): Promise<NativeAgentConfig> {
  return invoke(COMMANDS.NATIVE_AGENT_GET_CONFIG);
}

export async function nativeAgentSetConfig(config: NativeAgentConfig): Promise<void> {
  return invoke(COMMANDS.NATIVE_AGENT_SET_CONFIG, { config });
}

/** Fetches model ids from an OpenAI-compatible `{baseUrl}/models` endpoint. */
export async function nativeAgentListModels(baseUrl: string, apiKey: string): Promise<string[]> {
  return invoke(COMMANDS.NATIVE_AGENT_LIST_MODELS, { baseUrl, apiKey });
}

export async function nativeAgentListMcp(): Promise<NativeMcpServerInfo[]> {
  return invoke(COMMANDS.NATIVE_AGENT_LIST_MCP);
}

export async function nativeAgentUpsertMcp(server: NativeMcpUpsert): Promise<void> {
  return invoke(COMMANDS.NATIVE_AGENT_UPSERT_MCP, { server });
}

export async function nativeAgentDeleteMcp(name: string): Promise<void> {
  return invoke(COMMANDS.NATIVE_AGENT_DELETE_MCP, { name });
}

export async function nativeAgentSetMcpEnabled(name: string, enabled: boolean): Promise<void> {
  return invoke(COMMANDS.NATIVE_AGENT_SET_MCP_ENABLED, { name, enabled });
}

export async function nativeAgentProbeMcp(name: string): Promise<string> {
  return invoke(COMMANDS.NATIVE_AGENT_PROBE_MCP, { name });
}

export async function nativeAgentListSkills(): Promise<NativeSkillInfo[]> {
  return invoke(COMMANDS.NATIVE_AGENT_LIST_SKILLS);
}

export async function nativeAgentDeleteSkill(name: string): Promise<void> {
  return invoke(COMMANDS.NATIVE_AGENT_DELETE_SKILL, { name });
}

export async function nativeAgentSetSkillEnabled(name: string, enabled: boolean): Promise<void> {
  return invoke(COMMANDS.NATIVE_AGENT_SET_SKILL_ENABLED, { name, enabled });
}

export async function nativeAgentOpenSkillsDir(): Promise<string> {
  return invoke(COMMANDS.NATIVE_AGENT_OPEN_SKILLS_DIR);
}

// --- Git ---
export interface GitFileChange {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked";
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

export async function gitStatus(projectPath: string): Promise<GitStatus> {
  return invoke(COMMANDS.GIT_STATUS, { projectPath });
}

export async function gitDiff(projectPath: string, file: string, staged: boolean): Promise<string> {
  return invoke(COMMANDS.GIT_DIFF, { projectPath, file, staged });
}

export interface DiffContents {
  original: string;
  revised: string;
  binary: boolean;
}

export async function gitDiffContents(projectPath: string, file: string, staged: boolean): Promise<DiffContents> {
  return invoke(COMMANDS.GIT_DIFF_CONTENTS, { projectPath, file, staged });
}

export async function gitCommitPatch(projectPath: string, hash: string): Promise<string> {
  return invoke(COMMANDS.GIT_COMMIT_PATCH, { projectPath, hash });
}

export async function gitStage(projectPath: string, files: string[]): Promise<void> {
  return invoke(COMMANDS.GIT_STAGE, { projectPath, files });
}

export async function gitUnstage(projectPath: string, files: string[]): Promise<void> {
  return invoke(COMMANDS.GIT_UNSTAGE, { projectPath, files });
}

export async function gitCommit(projectPath: string, message: string): Promise<string> {
  return invoke(COMMANDS.GIT_COMMIT, { projectPath, message });
}

export interface BranchInfo {
  name: string;
  isHead: boolean;
  isRemote: boolean;
  ahead: number | null;
  behind: number | null;
  /** Tip commit time (seconds since epoch); null if unavailable. */
  tipTime: number | null;
}

export interface StashEntry {
  index: number;
  message: string;
  /** Stash commit OID — stable id for apply/pop/drop (index shifts on drop). */
  id: string;
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  time: number;
}

export async function gitLog(projectPath: string, limit: number): Promise<CommitInfo[]> {
  return invoke(COMMANDS.GIT_LOG, { projectPath, limit });
}

export async function gitListBranches(projectPath: string): Promise<BranchInfo[]> {
  return invoke(COMMANDS.GIT_LIST_BRANCHES, { projectPath });
}

export async function gitCheckout(projectPath: string, name: string): Promise<void> {
  return invoke(COMMANDS.GIT_CHECKOUT, { projectPath, name });
}

export async function gitCreateBranch(projectPath: string, name: string): Promise<void> {
  return invoke(COMMANDS.GIT_CREATE_BRANCH, { projectPath, name });
}

export async function gitDeleteBranch(projectPath: string, name: string): Promise<void> {
  return invoke(COMMANDS.GIT_DELETE_BRANCH, { projectPath, name });
}

export async function gitDiscard(projectPath: string, files: string[]): Promise<void> {
  return invoke(COMMANDS.GIT_DISCARD, { projectPath, files });
}

export async function gitRevertStaged(projectPath: string, files: string[]): Promise<void> {
  return invoke(COMMANDS.GIT_REVERT_STAGED, { projectPath, files });
}

export async function gitStashSave(projectPath: string, message: string): Promise<void> {
  return invoke(COMMANDS.GIT_STASH_SAVE, { projectPath, message });
}

export async function gitStashList(projectPath: string): Promise<StashEntry[]> {
  return invoke(COMMANDS.GIT_STASH_LIST, { projectPath });
}

export async function gitStashApply(projectPath: string, id: string): Promise<void> {
  return invoke(COMMANDS.GIT_STASH_APPLY, { projectPath, id });
}

export async function gitStashPop(projectPath: string, id: string): Promise<void> {
  return invoke(COMMANDS.GIT_STASH_POP, { projectPath, id });
}

export async function gitStashDrop(projectPath: string, id: string): Promise<void> {
  return invoke(COMMANDS.GIT_STASH_DROP, { projectPath, id });
}

export async function gitFetch(projectPath: string, remote: string): Promise<void> {
  return invoke(COMMANDS.GIT_FETCH, { projectPath, remote });
}

export async function gitPull(projectPath: string, remote: string): Promise<void> {
  return invoke(COMMANDS.GIT_PULL, { projectPath, remote });
}

export async function gitPush(projectPath: string, remote: string, branch: string): Promise<void> {
  return invoke(COMMANDS.GIT_PUSH, { projectPath, remote, branch });
}

export async function gitClone(url: string, dest: string): Promise<void> {
  return invoke(COMMANDS.GIT_CLONE, { url, dest });
}

export async function gitMerge(projectPath: string, branch: string): Promise<void> {
  return invoke(COMMANDS.GIT_MERGE, { projectPath, branch });
}

export async function gitCredentialRespond(
  requestId: string,
  username: string | null,
  password: string | null,
  remember: boolean,
): Promise<void> {
  return invoke(COMMANDS.GIT_CREDENTIAL_RESPOND, { requestId, username, password, remember });
}

// --- Terminal ---
export async function terminalCreate(
  projectPath: string,
  shell?: string,
  cols?: number,
  rows?: number,
): Promise<string> {
  return invoke(COMMANDS.TERMINAL_CREATE, { projectPath, shell, cols, rows });
}

export async function terminalWrite(terminalId: string, data: string): Promise<void> {
  return invoke(COMMANDS.TERMINAL_WRITE, { terminalId, data });
}

export async function terminalResize(terminalId: string, cols: number, rows: number): Promise<void> {
  return invoke(COMMANDS.TERMINAL_RESIZE, { terminalId, cols, rows });
}

export async function terminalKill(terminalId: string): Promise<void> {
  return invoke(COMMANDS.TERMINAL_KILL, { terminalId });
}

// --- FS ---
export interface FsNode {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
}

export async function fsReadTree(projectPath: string): Promise<FsNode[]> {
  return invoke(COMMANDS.FS_READ_TREE, { projectPath });
}

export async function fsExpandDir(dirPath: string): Promise<FsNode[]> {
  return invoke(COMMANDS.FS_EXPAND_DIR, { dirPath });
}

export async function fsReadFile(filePath: string): Promise<{ is_text: boolean; content?: string; size: number }> {
  return invoke(COMMANDS.FS_READ_FILE, { filePath });
}

export async function fsWriteFile(filePath: string, content: string): Promise<void> {
  return invoke(COMMANDS.FS_WRITE_FILE, { filePath, content });
}

export interface SearchMatch {
  path: string;
  name: string;
  line: number | null;
  text: string;
}

/** Match-rule toggles; all false = case-insensitive substring (the default). */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** Per-file replacement count in a preview (no disk writes). */
export interface ReplaceFilePreview {
  path: string;
  count: number;
}

export interface ReplacePreview {
  files: ReplaceFilePreview[];
  total: number;
  /** MAX_RESULTS budget exhausted — files beyond the cap were not visited. */
  truncated: boolean;
}

export interface ReplaceResult {
  filesChanged: number;
  replacements: number;
}

export async function fsSearch(projectPath: string, query: string, options: SearchOptions | null = null): Promise<SearchMatch[]> {
  return invoke(COMMANDS.FS_SEARCH, { projectPath, query, options });
}

export async function fsSearchReplace(
  projectPath: string,
  query: string,
  replacement: string,
  options: SearchOptions | null = null,
): Promise<ReplacePreview> {
  return invoke(COMMANDS.FS_SEARCH_REPLACE, { projectPath, query, replacement, options });
}

export async function fsApplyReplace(
  projectPath: string,
  query: string,
  replacement: string,
  options: SearchOptions | null = null,
  paths: string[] | null = null,
  limitPerFile: number | null = null,
): Promise<ReplaceResult> {
  return invoke(COMMANDS.FS_APPLY_REPLACE, { projectPath, query, replacement, options, paths, limitPerFile });
}

export async function fsWatchStart(projectPath: string): Promise<void> {
  return invoke(COMMANDS.FS_WATCH_START, { projectPath });
}

export async function fsWatchStop(projectPath: string): Promise<void> {
  return invoke(COMMANDS.FS_WATCH_STOP, { projectPath });
}

export async function fsCreateFile(parentDir: string, name: string): Promise<void> {
  return invoke(COMMANDS.FS_CREATE_FILE, { parentDir, name });
}

export async function fsCreateDir(parentDir: string, name: string): Promise<void> {
  return invoke(COMMANDS.FS_CREATE_DIR, { parentDir, name });
}

export async function fsDeleteEntry(path: string): Promise<void> {
  return invoke(COMMANDS.FS_DELETE_ENTRY, { path });
}

export async function fsRenameEntry(path: string, newName: string): Promise<void> {
  return invoke(COMMANDS.FS_RENAME_ENTRY, { path, newName });
}

export async function fsCopyEntry(source: string, targetDir: string): Promise<string> {
  return invoke(COMMANDS.FS_COPY_ENTRY, { source, targetDir });
}

export async function fsMoveEntry(source: string, targetDir: string): Promise<void> {
  return invoke(COMMANDS.FS_MOVE_ENTRY, { source, targetDir });
}

export async function fsImportFiles(sources: string[], targetDir: string): Promise<string[]> {
  return invoke(COMMANDS.FS_IMPORT_FILES, { sources, targetDir });
}

// --- Updater (GitHub Releases) ---
/** Result of comparing the running version against the latest GitHub release. */
export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_name: string;
  release_url: string;
  release_notes: string;
  /** Installer asset for this platform, if the release ships one. */
  asset_name: string | null;
  asset_url: string | null;
}

export async function updateCheckLatest(): Promise<UpdateInfo> {
  return invoke(COMMANDS.UPDATE_CHECK_LATEST);
}

/** Download the installer and run it; resolves before the app exits (Windows). */
export async function updateDownloadAndInstall(assetUrl: string, assetName: string): Promise<void> {
  return invoke(COMMANDS.UPDATE_DOWNLOAD_AND_INSTALL, { assetUrl, assetName });
}

/** Open an http(s) URL in the system browser (allowlisted in Rust). */
export async function openExternal(url: string): Promise<void> {
  return invoke(COMMANDS.OPEN_EXTERNAL, { url });
}

export function onUpdateDownloadProgress(cb: (payload: UpdateDownloadProgressPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.UPDATE_DOWNLOAD_PROGRESS, (e) => cb(e.payload as UpdateDownloadProgressPayload));
}

// --- Event Listeners ---
export function onAgentNotification(cb: (payload: AgentNotificationPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.AGENT_NOTIFICATION, (e) => cb(e.payload as AgentNotificationPayload));
}

export function onAgentPermissionRequest(cb: (payload: AgentPermissionRequestPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.AGENT_PERMISSION_REQUEST, (e) => cb(e.payload as AgentPermissionRequestPayload));
}

export function onAgentPlanApprovalRequest(
  cb: (payload: AgentPlanApprovalRequestPayload) => void,
): Promise<UnlistenFn> {
  return listen(EVENTS.AGENT_PLAN_APPROVAL_REQUEST, (e) => cb(e.payload as AgentPlanApprovalRequestPayload));
}

export function onAgentAskQuestionRequest(
  cb: (payload: AgentAskQuestionRequestPayload) => void,
): Promise<UnlistenFn> {
  return listen(EVENTS.AGENT_ASK_QUESTION_REQUEST, (e) => cb(e.payload as AgentAskQuestionRequestPayload));
}

export function onAgentSessionTerminated(cb: (payload: { sessionId: string }) => void): Promise<UnlistenFn> {
  return listen(EVENTS.AGENT_SESSION_TERMINATED, (e) => cb(e.payload as { sessionId: string }));
}

export function onTerminalOutput(cb: (payload: TerminalOutputPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.TERMINAL_OUTPUT, (e) => cb(e.payload as TerminalOutputPayload));
}

export function onTerminalExited(cb: (payload: TerminalExitedPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.TERMINAL_EXITED, (e) => cb(e.payload as TerminalExitedPayload));
}

export function onFsChanged(cb: (payload: FsChangedPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.FS_CHANGED, (e) => cb(e.payload as FsChangedPayload));
}

export function onGitStatusChanged(cb: (payload: GitStatusChangedPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.GIT_STATUS_CHANGED, (e) => cb(e.payload as GitStatusChangedPayload));
}

export function onGitCredentialRequest(cb: (payload: GitCredentialRequestPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.GIT_CREDENTIAL_REQUEST, (e) => cb(e.payload as GitCredentialRequestPayload));
}
