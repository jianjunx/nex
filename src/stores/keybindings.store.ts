import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { LazyStore } from "@tauri-apps/plugin-store";
import {
  canonicalToCombo,
  comboToCanonical,
  detectPlatform,
  type KeyCombo,
} from "../commands/types";
import { getCommand, listCommands } from "../commands/registry";

// Same persistence pattern as settings.store: a LazyStore writes
// keybindings.json in app-data; zustand holds the in-memory mirror.
const store = new LazyStore("keybindings.json", { autoSave: 300 });
const OVERRIDES_KEY = "overrides";

/** Platform-aware default (registry seed, with macOS Finder-style rename). */
function platformDefaultCombo(commandId: string): KeyCombo | null {
  if (commandId === "files.rename" && detectPlatform() === "mac") {
    return { key: "enter" };
  }
  return getCommand(commandId)?.defaultKey ?? null;
}

export interface ConflictRef {
  commandId: string;
  commandTitle: string;
}

interface KeybindingsState {
  /** load() 完成后置位。当前仅测试 mock 消费；保留以维持 mock 形状稳定。 */
  loaded: boolean;
  /** commandId -> canonical string | null (null = explicitly unbound). Absent = use default. */
  overrides: Record<string, string | null>;

  load: () => Promise<void>;
  resolve: (commandId: string) => KeyCombo | null;
  /** Apply an override; returns the other command that effectively owns the combo, if any. */
  setOverride: (commandId: string, combo: KeyCombo | null) => { conflict: ConflictRef | null };
  reset: (commandId: string) => void;
  /** Commands (other than excludeId) whose effective binding equals the canonical combo. */
  conflictsFor: (canonical: string | null, excludeId?: string) => ConflictRef[];
}

export const useKeybindingsStore = create<KeybindingsState>()(
  immer((set, get) => ({
    loaded: false,
    overrides: {},

    load: async () => {
      try {
        const raw = await store.get<Record<string, string | null>>(OVERRIDES_KEY);
        if (raw && typeof raw === "object") set((s) => { s.overrides = raw; });
      } catch {
        // Unreadable: keep empty overrides (all defaults).
      } finally {
        set((s) => { s.loaded = true; });
      }
    },

    resolve: (commandId) => {
      const { overrides } = get();
      if (commandId in overrides) return canonicalToCombo(overrides[commandId]);
      return platformDefaultCombo(commandId);
    },

    conflictsFor: (canonical, excludeId) => {
      if (!canonical) return [];
      const out: ConflictRef[] = [];
      for (const c of listCommands()) {
        if (c.id === excludeId) continue;
        const eff = comboToCanonical(get().resolve(c.id));
        if (eff === canonical) out.push({ commandId: c.id, commandTitle: c.title });
      }
      return out;
    },

    setOverride: (commandId, combo) => {
      const canonical = comboToCanonical(combo);
      const conflict = get().conflictsFor(canonical, commandId)[0] ?? null;
      set((s) => {
        const def = comboToCanonical(platformDefaultCombo(commandId));
        if (canonical === def) delete s.overrides[commandId]; // back to default
        else s.overrides[commandId] = canonical; // null canonical = unbound
      });
      void store.set(OVERRIDES_KEY, get().overrides).catch(() => {});
      return { conflict };
    },

    reset: (commandId) => {
      set((s) => { delete s.overrides[commandId]; });
      void store.set(OVERRIDES_KEY, get().overrides).catch(() => {});
    },
  }))
);
