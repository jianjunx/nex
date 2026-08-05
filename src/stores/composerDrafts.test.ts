import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetComposerDrafts,
  clearComposerDraft,
  loadComposerDraft,
  saveComposerDraft,
} from "./composerDrafts";

describe("composerDrafts", () => {
  beforeEach(() => {
    __resetComposerDrafts();
  });

  it("saves and restores text + mentions per conversation", () => {
    saveComposerDraft("c1", {
      text: "hello",
      mentions: [{ path: "/a.ts", name: "a.ts" }],
    });
    saveComposerDraft("c2", { text: "other", mentions: [] });

    expect(loadComposerDraft("c1")).toEqual({
      text: "hello",
      mentions: [{ path: "/a.ts", name: "a.ts" }],
    });
    expect(loadComposerDraft("c2")?.text).toBe("other");
  });

  it("drops empty drafts and clear removes entries", () => {
    saveComposerDraft("c1", { text: "x", mentions: [] });
    saveComposerDraft("c1", { text: "", mentions: [] });
    expect(loadComposerDraft("c1")).toBeNull();

    saveComposerDraft("c2", { text: "keep", mentions: [] });
    clearComposerDraft("c2");
    expect(loadComposerDraft("c2")).toBeNull();
  });
});
