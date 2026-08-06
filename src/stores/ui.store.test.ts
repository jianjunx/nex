/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { useUiStore } from "./ui.store";

describe("ui.store newConversationOpen", () => {
  it("open/close/toggle the dropdown flag", () => {
    useUiStore.setState({ newConversationOpen: false });
    useUiStore.getState().openNewConversation();
    expect(useUiStore.getState().newConversationOpen).toBe(true);
    useUiStore.getState().closeNewConversation();
    expect(useUiStore.getState().newConversationOpen).toBe(false);
    useUiStore.getState().toggleNewConversation();
    expect(useUiStore.getState().newConversationOpen).toBe(true);
    useUiStore.getState().toggleNewConversation();
    expect(useUiStore.getState().newConversationOpen).toBe(false);
  });
});

describe("ui.store settingsSection", () => {
  it("defaults to null and round-trips via setSettingsSection", () => {
    useUiStore.setState({ settingsSection: null });
    expect(useUiStore.getState().settingsSection).toBeNull();
    useUiStore.getState().setSettingsSection("nex-agent");
    expect(useUiStore.getState().settingsSection).toBe("nex-agent");
    useUiStore.getState().setSettingsSection(null);
    expect(useUiStore.getState().settingsSection).toBeNull();
  });

  it("keeps both new fields transient (excluded from persist partialize)", () => {
    const options = useUiStore.persist.getOptions() as unknown as {
      partialize: (s: unknown) => Record<string, unknown>;
    };
    const persisted = options.partialize(useUiStore.getState());
    expect(Object.keys(persisted)).not.toContain("newConversationOpen");
    expect(Object.keys(persisted)).not.toContain("settingsSection");
    expect(Object.keys(persisted)).not.toContain("settingsOpen");
  });
});
