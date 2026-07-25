import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { terminalCreate, terminalWrite, terminalResize, terminalKill, onTerminalOutput, onTerminalExited } from "../bridge/tauri";

interface TerminalSession {
  id: string;
  title: string;
}

interface TerminalStore {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  loading: boolean;
  error: string | null;
  /** Bumped when terminal-affecting settings change; TerminalPanel's construction effect depends on it, so a bump disposes + rebuilds xterm with the new options while the module-level output buffers keep the content alive across the rebuild. */
  settingsVersion: number;
  bumpSettingsVersion: () => void;

  create: (projectPath: string, shell?: string) => Promise<void>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  kill: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  clearError: () => void;
  /** Subscribes to terminal events. Returns an unlisten cleanup; safe to call from a StrictMode effect. */
  initListeners: () => () => void;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
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

export const useTerminalStore = create<TerminalStore>()(
  immer((set) => ({
    sessions: [],
    activeSessionId: null,
    loading: false,
    error: null,
    settingsVersion: 0,
    bumpSettingsVersion: () => { set((s) => { s.settingsVersion += 1; }); },

    create: async (projectPath: string, shell?: string) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const id = await terminalCreate(projectPath, shell);
        set((s) => {
          s.sessions.push({ id, title: `Terminal ${s.sessions.length + 1}` });
          s.activeSessionId = id;
        });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
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
          s.sessions = s.sessions.filter((t) => t.id !== id);
          if (s.activeSessionId === id) s.activeSessionId = s.sessions[0]?.id ?? null;
        });
        dropBuffer(id);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    setActive: (id: string) => { set((s) => { s.activeSessionId = id; }); },

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
        dropBuffer(terminalId);
        set((s) => {
          const idx = s.sessions.findIndex((t) => t.id === terminalId);
          if (idx === -1) return;
          s.sessions.splice(idx, 1);
          if (s.activeSessionId === terminalId) s.activeSessionId = s.sessions[0]?.id ?? null;
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
