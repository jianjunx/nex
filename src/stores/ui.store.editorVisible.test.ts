/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./ui.store";
import { useProjectStore } from "./project.store";

describe("ui.store editorVisibleByProject", () => {
  beforeEach(() => {
    useProjectStore.setState({ activeProjectId: "proj-a" });
    useUiStore.setState({
      editorVisible: false,
      editorVisibleByProject: {},
    });
  });

  it("remembers hide/show per project and restores on sync", () => {
    useUiStore.getState().setEditorVisible(true);
    expect(useUiStore.getState().editorVisible).toBe(true);
    expect(useUiStore.getState().editorVisibleByProject["proj-a"]).toBe(true);

    useUiStore.getState().setEditorVisible(false);
    expect(useUiStore.getState().editorVisibleByProject["proj-a"]).toBe(false);

    useProjectStore.setState({ activeProjectId: "proj-b" });
    useUiStore.getState().syncEditorVisibleForProject("proj-b", true);
    expect(useUiStore.getState().editorVisible).toBe(true);
    expect(useUiStore.getState().editorVisibleByProject["proj-b"]).toBe(true);

    useUiStore.getState().syncEditorVisibleForProject("proj-a");
    expect(useUiStore.getState().editorVisible).toBe(false);
  });

  it("persists editorVisibleByProject in partialize", () => {
    useUiStore.getState().setEditorVisible(true);
    const options = useUiStore.persist.getOptions() as unknown as {
      partialize: (s: unknown) => Record<string, unknown>;
    };
    const persisted = options.partialize(useUiStore.getState());
    expect(persisted.editorVisibleByProject).toEqual({ "proj-a": true });
  });
});
