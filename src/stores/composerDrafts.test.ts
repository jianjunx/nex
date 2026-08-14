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
      images: [],
    });
    saveComposerDraft("c2", { text: "other", mentions: [], images: [] });

    expect(loadComposerDraft("c1")).toEqual({
      text: "hello",
      mentions: [{ path: "/a.ts", name: "a.ts" }],
      images: [],
    });
    expect(loadComposerDraft("c2")?.text).toBe("other");
  });

  it("drops image-only drafts instead of retaining base64 across conversations", () => {
    saveComposerDraft("c1", {
      text: "",
      mentions: [],
      images: [{ id: "i1", mimeType: "image/png", data: "abc" }],
    });
    saveComposerDraft("c2", {
      text: "hi",
      mentions: [],
      images: [{ id: "i2", mimeType: "image/jpeg", data: "xyz" }],
    });

    expect(loadComposerDraft("c1")).toBeNull();
    expect(loadComposerDraft("c2")?.images).toEqual([]);
  });

  it("does not retain image payloads in drafts", () => {
    const images = [{ id: "i1", mimeType: "image/png", data: "abc" }];
    saveComposerDraft("c1", { text: "", mentions: [], images });
    images[0]!.data = "mutated";
    expect(loadComposerDraft("c1")).toBeNull();
  });

  it("drops empty drafts and clear removes entries", () => {
    saveComposerDraft("c1", { text: "x", mentions: [], images: [] });
    saveComposerDraft("c1", { text: "", mentions: [], images: [] });
    expect(loadComposerDraft("c1")).toBeNull();

    saveComposerDraft("c2", { text: "keep", mentions: [], images: [] });
    clearComposerDraft("c2");
    expect(loadComposerDraft("c2")).toBeNull();
  });
});
