import { create } from "zustand";

export interface ClipboardEntry {
  path: string;
  isCut: boolean; // true = cut, false = copy
}

interface ClipboardStore {
  entries: ClipboardEntry[];
  setEntries: (entries: ClipboardEntry[]) => void;
  clear: () => void;
  /** True when the clipboard has at least one entry. */
  hasEntries: () => boolean;
  /** Get all dir paths of clipboard entries (for paste — determine target parent). */
}

export const useClipboardStore = create<ClipboardStore>((set, get) => ({
  entries: [],
  setEntries: (entries) => set({ entries }),
  clear: () => set({ entries: [] }),
  hasEntries: () => get().entries.length > 0,
}));
