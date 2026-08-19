import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { type UnlistenFn } from "@tauri-apps/api/event";
import {
  terminalCreate,
  terminalWrite,
  terminalResize,
  terminalKill,
  onTerminalOutput,
  onTerminalExited,
} from "../bridge/tauri";
import { errorMessage } from "../lib/errors";

interface TerminalSession {
  id: string;
  title: string;
  /** Owning project — sessions survive project switches (PTY kept alive). */
  projectId: string;
}

interface TerminalStore {
  sessions: TerminalSession[];
  /**
   * Active session for the current project (derived UI). Kept in sync with
   * `activeSessionByProject[activeProjectId]` via setActive / create / kill.
   * Background projects keep their own active id in `activeSessionByProject`.
   */
  activeSessionId: string | null;
  /** Last-focused session id per project. */
  activeSessionByProject: Record<string, string | null>;
  loading: boolean;
  error: string | null;
  /** Bumped when terminal-affecting settings change; TerminalPanel's construction effect depends on it, so a bump disposes + rebuilds xterm with the new options while the module-level output buffers keep the content alive across the rebuild. */
  settingsVersion: number;
  bumpSettingsVersion: () => void;

  create: (projectId: string, projectPath: string, shell?: string, cols?: number, rows?: number) => Promise<void>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  kill: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  /** Switch visible terminal set to a project's sessions (no PTY kill). */
  focusProject: (projectId: string | null) => void;
  clearError: () => void;
  /** Subscribes to terminal events. Returns an unlisten cleanup; safe to call from a StrictMode effect. */
  initListeners: () => () => void;
}

// Backend errors arrive as { type, message }; fall back to String(err).
/** Sessions belonging to a project (stable empty array for selectors). */
const EMPTY_SESSIONS: TerminalSession[] = [];

export function selectProjectSessions(
  sessions: TerminalSession[],
  projectId: string | null | undefined,
): TerminalSession[] {
  if (!projectId) return EMPTY_SESSIONS;
  const list = sessions.filter((s) => s.projectId === projectId);
  return list.length === 0 ? EMPTY_SESSIONS : list;
}

export function selectProjectActiveSessionId(
  s: Pick<TerminalStore, "sessions" | "activeSessionByProject">,
  projectId: string | null | undefined,
): string | null {
  if (!projectId) return null;
  return pickActiveForProject(s.sessions, projectId, s.activeSessionByProject[projectId]);
}

// Per-session output ring buffers, kept OUTSIDE zustand state: output arrives
// at keystroke frequency, and routing it through immer would draft the whole
// store and re-render every subscriber per chunk. The app-scope listener
// (initListeners, wired from App.tsx) appends here from t=0 — before any PTY
// can be spawned — so a session's very first output (shell banner/prompt) is
// never lost to a spawn→subscribe race.
const BUFFER_CAP = 262_144; // chars per session; oldest chunks dropped on overflow
const outputBuffers = new Map<string, { chunks: string[]; length: number }>();

function appendOutput(terminalId: string, data: string): void {
  if (data.length === 0) return;
  let buf = outputBuffers.get(terminalId);
  if (!buf) {
    buf = { chunks: [], length: 0 };
    outputBuffers.set(terminalId, buf);
  }
  buf.chunks.push(data);
  buf.length += data.length;
  while (buf.length > BUFFER_CAP && buf.chunks.length > 1) {
    const dropped = buf.chunks.shift();
    if (dropped) buf.length -= dropped.length;
  }
  if (buf.length > BUFFER_CAP && buf.chunks.length === 1) {
    // A single chunk larger than the cap: keep the tail.
    buf.chunks[0] = buf.chunks[0].slice(buf.chunks[0].length - BUFFER_CAP);
    buf.length = buf.chunks[0].length;
  }
}

/** Full buffered output for a session, for xterm replay on (re)mount/switch. */
export function getReplay(terminalId: string): string {
  return outputBuffers.get(terminalId)?.chunks.join("") ?? "";
}

function dropBuffer(terminalId: string): void {
  outputBuffers.delete(terminalId);
}

// Module-level so the active teardown survives store re-reads; StrictMode
// mounts -> cleans up -> re-mounts, and this guard prevents double subscription.
// (Same pattern as agent.store.ts.)
let listenerTeardown: (() => void) | null = null;

// Live sink: the output listener also hands each chunk to the mounted
// terminal for immediate rendering. Buffering alone would leave the
// display frozen between tab switches (no keystroke echo / command
// output until a replay re-dumps the buffer). The sink is a plain
// function, NOT a listener — event subscription stays app-scope in
// initListeners; TerminalPanel sets/clears it on mount/unmount.
let liveSink: ((terminalId: string, data: string) => void) | null = null;

export function setLiveSink(fn: ((terminalId: string, data: string) => void) | null): void {
  liveSink = fn;
}

function nextTitle(sessions: TerminalSession[], projectId: string): string {
  const n = sessions.filter((s) => s.projectId === projectId).length + 1;
  return `Terminal ${n}`;
}

function pickActiveForProject(
  sessions: TerminalSession[],
  projectId: string,
  preferred: string | null | undefined,
): string | null {
  if (preferred && sessions.some((s) => s.id === preferred && s.projectId === projectId)) {
    return preferred;
  }
  return sessions.find((s) => s.projectId === projectId)?.id ?? null;
}

export const useTerminalStore = create<TerminalStore>()(
  immer((set) => ({
    sessions: [],
    activeSessionId: null,
    activeSessionByProject: {},
    loading: false,
    error: null,
    settingsVersion: 0,
    bumpSettingsVersion: () => { set((s) => { s.settingsVersion += 1; }); },

    create: async (projectId, projectPath, shell?, cols?, rows?) => {
      set((s) => { s.loading = true; s.error = null; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      // Pass the live xterm size so the PTY/zsh `$COLUMNS` match from the
      // first prompt — avoids a spurious inverse `%` (PROMPT_EOL_MARK) when
      // the frontend already fitted before any session existed (onResize
      // was a no-op then, so a default 80×24 PTY never caught up).
      const spawn = terminalCreate(projectPath, shell, cols, rows);
      try {
        // Race the spawn against a deadline: if the PTY invoke hangs (a blocked
        // ConPTY never resolving), surface it instead of a forever-loading "+".
        const id = await Promise.race([
          spawn,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error("终端启动超时：底层 PTY 未响应。可能是安全软件拦截了 ConPTY，或指定的 shell 无效。"));
            }, 8000);
          }),
        ]);
        set((s) => {
          s.sessions.push({
            id,
            title: nextTitle(s.sessions, projectId),
            projectId,
          });
          s.activeSessionByProject[projectId] = id;
          s.activeSessionId = id;
        });
        // Belt-and-braces: push size again now that the session exists, in
        // case xterm fitted between invoke start and session registration.
        if (cols && rows) {
          void terminalResize(id, cols, rows).catch(() => { /* best-effort */ });
        }
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
        // If we timed out but the backend PTY still materializes moments
        // later, kill it so it doesn't linger as an orphan session.
        if (timedOut) {
          void spawn
            .then((lateId) => terminalKill(lateId))
            .catch(() => { /* spawn failed too — nothing to clean up */ });
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        set((s) => { s.loading = false; });
      }
    },

    // Fire-and-forget: keystroke/resize-frequency traffic, so failures are
    // recorded without toggling `loading`.
    write: (id: string, data: string) => {
      terminalWrite(id, data).catch((err) => {
        set((s) => { s.error = errorMessage(err); });
      });
    },

    resize: (id: string, cols: number, rows: number) => {
      terminalResize(id, cols, rows).catch((err) => {
        set((s) => { s.error = errorMessage(err); });
      });
    },

    kill: async (id: string) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        await terminalKill(id);
        set((s) => {
          const dying = s.sessions.find((t) => t.id === id);
          s.sessions = s.sessions.filter((t) => t.id !== id);
          if (dying) {
            const next = pickActiveForProject(
              s.sessions,
              dying.projectId,
              s.activeSessionByProject[dying.projectId] === id
                ? null
                : s.activeSessionByProject[dying.projectId],
            );
            s.activeSessionByProject[dying.projectId] = next;
            if (s.activeSessionId === id) s.activeSessionId = next;
          }
        });
        dropBuffer(id);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    setActive: (id: string) => {
      set((s) => {
        const session = s.sessions.find((t) => t.id === id);
        if (!session) return;
        s.activeSessionId = id;
        s.activeSessionByProject[session.projectId] = id;
      });
    },

    focusProject: (projectId) => {
      set((s) => {
        if (!projectId) {
          s.activeSessionId = null;
          return;
        }
        const next = pickActiveForProject(
          s.sessions,
          projectId,
          s.activeSessionByProject[projectId],
        );
        s.activeSessionByProject[projectId] = next;
        s.activeSessionId = next;
      });
    },

    clearError: () => { set((s) => { s.error = null; }); },

    initListeners: () => {
      if (listenerTeardown) return listenerTeardown;
      let disposed = false;
      let unlistenOutput: UnlistenFn | null = null;
      let unlistenExited: UnlistenFn | null = null;

      // Append to the module-level ring buffer only — NO set() here —
      // keeping the keystroke-frequency hot path out of immer/re-renders.
      onTerminalOutput(({ terminalId, data }) => {
        appendOutput(terminalId, data);
        liveSink?.(terminalId, data);
      }).then((fn) => { if (disposed) fn(); else unlistenOutput = fn; });

      // The shell exited (EOF/err): drop its buffer and remove the tab.
      // kill() also removes locally, so a late exited event for an
      // already-removed id is a tolerated no-op.
      onTerminalExited(({ terminalId }) => {
        // A shell that exits having produced no output almost certainly failed
        // to start (bad/missing shell, ConPTY/AV block, env). A normal `exit`
        // always prints something first, so its buffer is non-empty and stays
        // silent. This turns the silent "tab flashes then vanishes" case into
        // a visible diagnostic.
        const hadOutput = (outputBuffers.get(terminalId)?.length ?? 0) > 0;
        dropBuffer(terminalId);
        set((s) => {
          const idx = s.sessions.findIndex((t) => t.id === terminalId);
          if (idx === -1) return;
          const dying = s.sessions[idx]!;
          s.sessions.splice(idx, 1);
          const next = pickActiveForProject(
            s.sessions,
            dying.projectId,
            s.activeSessionByProject[dying.projectId] === terminalId
              ? null
              : s.activeSessionByProject[dying.projectId],
          );
          s.activeSessionByProject[dying.projectId] = next;
          if (s.activeSessionId === terminalId) s.activeSessionId = next;
          if (!hadOutput) {
            s.error = "终端进程启动后立即退出。请在 设置 → 终端 → Shell 指定一个有效 shell（如 cmd.exe 或 powershell.exe），或检查是否有安全软件拦截终端（ConPTY）。";
          }
        });
      }).then((fn) => { if (disposed) fn(); else unlistenExited = fn; });

      listenerTeardown = () => {
        disposed = true;
        unlistenOutput?.();
        unlistenExited?.();
        listenerTeardown = null;
      };
      return listenerTeardown;
    },
  }))
);
