// src/stores/keybindings.store.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const setMock = vi.fn();
const getMock = vi.fn();
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    constructor() {}
    get = (...a: unknown[]) => getMock(...a);
    set = (...a: unknown[]) => setMock(...a);
  },
}));

import { comboToCanonical } from "../commands/types";
import { useKeybindingsStore } from "./keybindings.store";

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue(undefined);
  setMock.mockResolvedValue(undefined);
  useKeybindingsStore.setState({ loaded: true, overrides: {} });
});

describe("keybindings store", () => {
  it("resolve returns the default when no override", () => {
    const combo = useKeybindingsStore.getState().resolve("editor.save");
    expect(comboToCanonical(combo)).toBe("primary+keys");
  });

  it("resolve returns the override when set", () => {
    useKeybindingsStore.setState({ overrides: { "editor.save": "primary+alt+keys" } });
    const combo = useKeybindingsStore.getState().resolve("editor.save");
    expect(comboToCanonical(combo)).toBe("primary+alt+keys");
  });

  it("resolve returns null when unbound", () => {
    useKeybindingsStore.setState({ overrides: { "editor.save": null } });
    expect(useKeybindingsStore.getState().resolve("editor.save")).toEqual({ key: null });
  });

  it("setOverride reports a conflict with the effective owner", () => {
    // editor.save default is primary+keys; rebinding editor.close to it conflicts.
    const res = useKeybindingsStore
      .getState()
      .setOverride("editor.close", { primary: true, key: "keys" });
    expect(res.conflict?.commandId).toBe("editor.save");
  });

  it("setOverride ignores self-conflict when re-recording same command", () => {
    useKeybindingsStore.setState({ overrides: { "editor.save": "primary+alt+keys" } });
    const res = useKeybindingsStore
      .getState()
      .setOverride("editor.save", { primary: true, alt: true, key: "keys" });
    expect(res.conflict).toBeNull();
  });

  it("setOverride persists and reset clears", () => {
    useKeybindingsStore.getState().setOverride("editor.save", { primary: true, alt: true, key: "keys" });
    expect(setMock).toHaveBeenCalled();
    useKeybindingsStore.getState().reset("editor.save");
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBeUndefined();
  });

  it("load hydrates overrides from the store", async () => {
    getMock.mockResolvedValueOnce({ "editor.save": null });
    await useKeybindingsStore.getState().load();
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBeNull();
    expect(useKeybindingsStore.getState().loaded).toBe(true);
  });

  it("setOverride collapses to default when the combo equals the default", () => {
    // 先污染一个覆盖，再录回默认键（editor.save 默认 primary+keys）→ 覆盖应被删除
    useKeybindingsStore.setState({ overrides: { "editor.save": "primary+alt+keys" } });
    useKeybindingsStore.getState().setOverride("editor.save", { primary: true, key: "keys" });
    expect("editor.save" in useKeybindingsStore.getState().overrides).toBe(false);
  });
});
