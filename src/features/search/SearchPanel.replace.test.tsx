/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

type SearchOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
type SearchMatch = { path: string; name: string; line: number | null; text: string };
type ReplacePreview = { files: { path: string; count: number }[]; total: number; truncated: boolean };

let fsState: {
  searchResults: SearchMatch[];
  searching: boolean;
  searchError: string | null;
  searchOptions: SearchOptions;
  replacePreview: ReplacePreview | null;
  replacing: boolean;
  search: ReturnType<typeof vi.fn>;
  clearSearch: ReturnType<typeof vi.fn>;
  setSearchOptions: ReturnType<typeof vi.fn>;
  openFile: ReturnType<typeof vi.fn>;
  previewReplace: ReturnType<typeof vi.fn>;
  applyReplace: ReturnType<typeof vi.fn>;
  clearReplacePreview: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/fs.store", () => ({
  useFsStore: Object.assign(
    (sel?: (s: typeof fsState) => unknown) => (sel ? sel(fsState) : fsState),
    { getState: () => fsState },
  ),
}));

let projectState: { projects: { id: string; path: string }[]; activeProjectId: string | null };
vi.mock("../../stores/project.store", () => ({
  useProjectStore: Object.assign(
    (sel?: (s: typeof projectState) => unknown) => (sel ? sel(projectState) : projectState),
    { getState: () => projectState },
  ),
}));

import { SearchPanel } from "./SearchPanel";

beforeEach(() => {
  // 假定时器：冻结搜索防抖，替换流断言只验证显式路径（预览/写盘/重搜）
  vi.useFakeTimers();
  fsState = {
    searchResults: [
      { path: "/proj/src/a.ts", name: "a.ts", line: 1, text: "const foo = 1;" },
      { path: "/proj/src/a.ts", name: "a.ts", line: 3, text: "let foo2 = 2;" },
    ],
    searching: false,
    searchError: null,
    searchOptions: { caseSensitive: false, wholeWord: false, regex: false },
    replacePreview: null,
    replacing: false,
    search: vi.fn().mockResolvedValue(undefined),
    clearSearch: vi.fn(),
    setSearchOptions: vi.fn(),
    openFile: vi.fn().mockResolvedValue(undefined),
    previewReplace: vi.fn().mockResolvedValue(undefined),
    applyReplace: vi.fn().mockResolvedValue({ filesChanged: 1, replacements: 2 }),
    clearReplacePreview: vi.fn(),
  };
  projectState = { projects: [{ id: "p1", path: "/proj" }], activeProjectId: "p1" };
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function fillQueryAndReplacement() {
  render(<SearchPanel />);
  fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "foo" } });
  fireEvent.change(screen.getByLabelText("替换"), { target: { value: "bar" } });
}

describe("replace-all flow", () => {
  it("previews, confirms in dialog, applies, then auto re-searches", async () => {
    fsState.previewReplace = vi.fn(async () => {
      fsState.replacePreview = { files: [{ path: "/proj/src/a.ts", count: 2 }], total: 2, truncated: false };
    });
    fillQueryAndReplacement();
    fireEvent.click(screen.getByRole("button", { name: "替换全部" }));
    await act(async () => {}); // 等 previewReplace resolve + 本地 setState
    expect(fsState.previewReplace).toHaveBeenCalledWith("/proj", "foo", "bar");
    expect(screen.getByText("将修改 1 个文件共 2 处。此操作直接写盘，请确认。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    await act(async () => {});
    expect(fsState.applyReplace).toHaveBeenCalledWith("/proj", "foo", "bar", undefined);
    // 自动重搜
    expect(fsState.search).toHaveBeenCalledWith("/proj", "foo");
  });

  it("shows the truncation warning when the preview hit the cap", async () => {
    fsState.previewReplace = vi.fn(async () => {
      fsState.replacePreview = { files: [{ path: "/proj/big.txt", count: 200 }], total: 200, truncated: true };
    });
    fillQueryAndReplacement();
    fireEvent.click(screen.getByRole("button", { name: "替换全部" }));
    await act(async () => {});
    expect(screen.getByText("结果已达上限，仅替换前 200 处所在文件。")).toBeTruthy();
  });

  it("cancel closes the dialog without applying", async () => {
    fsState.previewReplace = vi.fn(async () => {
      fsState.replacePreview = { files: [{ path: "/proj/src/a.ts", count: 2 }], total: 2, truncated: false };
    });
    fillQueryAndReplacement();
    fireEvent.click(screen.getByRole("button", { name: "替换全部" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(fsState.applyReplace).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("replace-all is disabled without a query", () => {
    render(<SearchPanel />);
    expect((screen.getByRole("button", { name: "替换全部" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains the stale-banner behavior under the replace row", () => {
    render(<SearchPanel />);
    expect(screen.getByText("已打开的未保存文件会标记为过期")).toBeTruthy();
  });
});

describe("scoped replaces", () => {
  it("group-header button replaces all matches in that file, then re-searches", async () => {
    fillQueryAndReplacement();
    fireEvent.click(screen.getByTitle("替换本文件全部匹配"));
    await act(async () => {});
    expect(fsState.applyReplace).toHaveBeenCalledWith("/proj", "foo", "bar", { paths: ["/proj/src/a.ts"] });
    expect(fsState.search).toHaveBeenCalledWith("/proj", "foo");
  });

  it("row button replaces the first match in that file (limitPerFile=1)", async () => {
    fillQueryAndReplacement();
    fireEvent.click(screen.getAllByTitle("替换本文件首个匹配")[0]);
    await act(async () => {});
    expect(fsState.applyReplace).toHaveBeenCalledWith("/proj", "foo", "bar", {
      paths: ["/proj/src/a.ts"],
      limitPerFile: 1,
    });
    expect(fsState.search).toHaveBeenCalledWith("/proj", "foo");
  });
});
