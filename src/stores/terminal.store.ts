import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { terminalCreate, terminalWrite, terminalResize, terminalKill } from "../bridge/tauri";

interface TerminalSession {
  id: string;
  title: string;
}

interface TerminalStore {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  loading: boolean;
  error: string | null;

  create: (projectPath: string) => Promise<void>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  kill: (id: string) => Promise<void>;
  setActive: (id: string) => void;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export const useTerminalStore = create<TerminalStore>()(
  immer((set) => ({
    sessions: [],
    activeSessionId: null,
    loading: false,
    error: null,

    create: async (projectPath: string) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const id = await terminalCreate(projectPath);
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
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    setActive: (id: string) => { set((s) => { s.activeSessionId = id; }); },
  }))
);
