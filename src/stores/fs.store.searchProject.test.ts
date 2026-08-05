import { beforeEach, describe, expect, it, vi } from "vitest";

const fsSearch = vi.fn();
const setEditorVisible = vi.fn();
const syncEditorVisibleForProject = vi.fn();

vi.mock("../bridge/tauri", () => ({
  fsSearch: (...args: unknown[]) => fsSearch(...args),
  fsReadFile: vi.fn(),
  fsWriteFile: vi.fn(),
  fsReadTree: vi.fn(),
  fsExpandDir: vi.fn(),
}));

vi.mock("./ui.store", () => ({
  useUiStore: { getState: () => ({ setEditorVisible, syncEditorVisibleForProject }) },
}));

vi.mock("./settings.store", () => ({
  useSettingsStore: { getState: () => ({ editorAutoSave: false }) },
}));

import { useFsStore } from "./fs.store";
import {
  __resetSearchProjectQuery,
  focusSearchQueryProject,
  readSearchQuery,
  writeSearchQuery,
} from "./searchProjectQuery";

describe("switchSearchProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSearchProjectQuery();
    useFsStore.setState({
      searchResults: [{ path: "/a", name: "a", line: 1, text: "x" }],
      searching: false,
      searchError: null,
      searchOptions: { caseSensitive: true, wholeWord: false, regex: false },
      searchOwnerProjectId: "proj-a",
      searchByProject: {},
      replacePreview: null,
    });
    focusSearchQueryProject("proj-a");
    writeSearchQuery("foo");
  });

  it("clears results and restores per-project query/options", () => {
    useFsStore.getState().switchSearchProject("proj-b");
    expect(useFsStore.getState().searchResults).toEqual([]);
    expect(useFsStore.getState().searchOwnerProjectId).toBe("proj-b");
    expect(readSearchQuery()).toBe("");
    expect(useFsStore.getState().searchOptions).toEqual({
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });

    writeSearchQuery("bar");
    useFsStore.getState().setSearchOptions({ regex: true });
    useFsStore.getState().switchSearchProject("proj-a");
    expect(readSearchQuery()).toBe("foo");
    expect(useFsStore.getState().searchOptions.caseSensitive).toBe(true);
    expect(useFsStore.getState().searchOptions.regex).toBe(false);
    expect(useFsStore.getState().searchResults).toEqual([]);
  });
});
