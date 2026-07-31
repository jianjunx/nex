/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

type SearchOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
type SearchMatch = { path: string; name: string; line: number | null; text: string };

let fsState: {
  searchResults: SearchMatch[];
  searching: boolean;
  searchError: string | null;
  searchOptions: SearchOptions;
  search: ReturnType<typeof vi.fn>;
  clearSearch: ReturnType<typeof vi.fn>;
  setSearchOptions: ReturnType<typeof vi.fn>;
  openFile: ReturnType<typeof vi.fn>;
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
  vi.useFakeTimers();
  fsState = {
    searchResults: [],
    searching: false,
    searchError: null,
    searchOptions: { caseSensitive: false, wholeWord: false, regex: false },
    search: vi.fn().mockResolvedValue(undefined),
    clearSearch: vi.fn(),
    setSearchOptions: vi.fn(),
    openFile: vi.fn().mockResolvedValue(undefined),
  };
  projectState = { projects: [{ id: "p1", path: "/proj" }], activeProjectId: "p1" };
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("search row flags", () => {
  it("renders three toggles reflecting the store and flips them", () => {
    render(<SearchPanel />);
    fireEvent.click(screen.getByTitle("区分大小写"));
    expect(fsState.setSearchOptions).toHaveBeenCalledWith({ caseSensitive: true });
    fireEvent.click(screen.getByTitle("全字匹配"));
    expect(fsState.setSearchOptions).toHaveBeenCalledWith({ wholeWord: true });
    fireEvent.click(screen.getByTitle("使用正则表达式"));
    expect(fsState.setSearchOptions).toHaveBeenCalledWith({ regex: true });
  });

  it("aria-pressed mirrors the stored flags", () => {
    fsState.searchOptions = { caseSensitive: true, wholeWord: false, regex: true };
    render(<SearchPanel />);
    expect(screen.getByTitle("区分大小写").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTitle("全字匹配").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTitle("使用正则表达式").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("debounced search", () => {
  it("fires with the raw query after 300ms", async () => {
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: " foo " } });
    expect(fsState.search).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(fsState.search).toHaveBeenCalledWith("/proj", " foo ");
  });

  it("toggling a flag re-runs the search", async () => {
    const utils = render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "foo" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fsState.search.mockClear();
    // 模拟 store 已更新选项（真实场景由 setSearchOptions 完成）
    fsState.searchOptions = { caseSensitive: true, wholeWord: false, regex: false };
    utils.rerender(<SearchPanel />); // 同 root 重渲让 selector 取新值、deps 变更触发新防抖
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(fsState.search).toHaveBeenCalled();
  });
});

describe("invalid regex", () => {
  it("shows an inline error and does not search", async () => {
    fsState.searchOptions = { caseSensitive: false, wholeWord: false, regex: true };
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "([broken" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByRole("alert").textContent).toContain("无效的正则表达式: ([broken");
    expect(fsState.search).not.toHaveBeenCalled();
  });

  it("backend searchError is rendered inline too", () => {
    fsState.searchError = "无效的正则表达式: (?P<x>";
    render(<SearchPanel />);
    expect(screen.getByRole("alert").textContent).toContain("无效的正则表达式");
  });
});

describe("stats bar & toolbar", () => {
  it("counts results and files", () => {
    fsState.searchResults = [
      { path: "/proj/a.ts", name: "a.ts", line: 1, text: "foo" },
      { path: "/proj/a.ts", name: "a.ts", line: 3, text: "foo" },
      { path: "/proj/b.ts", name: "b.ts", line: 2, text: "foo" },
    ];
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "foo" } });
    expect(screen.getByText("3 个结果 / 2 个文件")).toBeTruthy();
  });

  it("shows a spinner while searching", () => {
    fsState.searching = true;
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "foo" } });
    expect(screen.getByText("搜索中…")).toBeTruthy();
  });

  it("clear button empties the query and clears results", () => {
    render(<SearchPanel />);
    const input = screen.getByLabelText("搜索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "foo" } });
    fireEvent.click(screen.getByTitle("清除"));
    expect(input.value).toBe("");
    expect(fsState.clearSearch).toHaveBeenCalled();
  });

  it("refresh button re-runs the search immediately", () => {
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "foo" } });
    fsState.search.mockClear();
    fireEvent.click(screen.getByTitle("重新搜索"));
    expect(fsState.search).toHaveBeenCalledWith("/proj", "foo");
  });

  it("renders a disabled glob filter placeholder (v1 预留位)", () => {
    render(<SearchPanel />);
    const filter = screen.getByPlaceholderText(/要包含的文件/) as HTMLInputElement;
    expect(filter.disabled).toBe(true);
    expect(filter.getAttribute("title")).toBe("后续版本支持");
  });
});
