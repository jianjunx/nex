import { create } from "zustand";
import type { GitCredentialRequestPayload } from "../../bridge/events";

interface GitCredentialRequestStore {
  queue: GitCredentialRequestPayload[];
  pushRequest: (req: GitCredentialRequestPayload) => void;
  removeRequest: (requestId: string) => void;
}

export const useGitCredentialStore = create<GitCredentialRequestStore>()((set) => ({
  queue: [],
  pushRequest: (req) => set((s) => ({ queue: [...s.queue, req] })),
  removeRequest: (requestId) =>
    set((s) => ({ queue: s.queue.filter((r) => r.requestId !== requestId) })),
}));
