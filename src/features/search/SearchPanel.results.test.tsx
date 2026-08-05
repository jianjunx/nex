/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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

import { SearchPanel, __resetReplaceUiByProject } from "./SearchPanel";
import { __resetSearchProjectQuery } from "../../stores/searchProjectQuery";

const RESULTS: SearchMatch[] = [
  { path: "/proj/src/a.ts", name: "a.ts", line: 1, text: "const foo = 1;" },
  { path: "/proj/src/a.ts", name: "a.ts", line: 3, text: "let foo2 = 2;" },
  { path: "/proj/b.ts", name: "b.ts", line: 2, text: "foo again" },
  { path: "/proj/readme.md", name: "readme.md", line: null, text: "" },
];

beforeEach(() => {
  __resetReplaceUiByProject();
  __resetSearchProjectQuery();
  fsState = {
    searchResults: RESULTS,
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
afterEach(() => cleanup());

function renderWithQuery() {
  const utils = render(<SearchPanel />);
  fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "foo" } });
  return utils;
}

function groupHeaders() {
  return within(screen.getByTestId("search-result-list"))
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"));
}

describe("grouped results", () => {
  it("groups by file with name / relative path / count badge", () => {
    const { container } = renderWithQuery();
    // 三个分组：a.ts(2) / b.ts(1) / readme.md(1 名称命中)
    expect(groupHeaders()).toHaveLength(3);
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    const badges = [...container.querySelectorAll("[data-count-badge]")].map((n) => n.textContent);
    expect(badges).toEqual(["2", "1", "1"]);
  });

  it("highlights the hit inside the line text with <mark>", () => {
    renderWithQuery();
    const marks = document.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThanOrEqual(3);
    expect([...marks].some((m) => m.textContent === "foo")).toBe(true);
  });

  it("collapses and expands a group via its header", () => {
    renderWithQuery();
    const header = groupHeaders().find((b) => b.textContent?.includes("a.ts"))!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapse-all / expand-all toolbar buttons toggle every group", () => {
    renderWithQuery();
    fireEvent.click(screen.getByTitle("折叠全部"));
    expect(groupHeaders().every((h) => h.getAttribute("aria-expanded") === "false")).toBe(true);
    fireEvent.click(screen.getByTitle("展开全部"));
    expect(groupHeaders().every((h) => h.getAttribute("aria-expanded") === "true")).toBe(true);
  });

  it("clicking a content row opens the file at that line", () => {
    renderWithQuery();
    // <mark> 将行文本切成三段，getByText("const ") 不可得；经 mark 文本定位行按钮
    fireEvent.click(screen.getAllByText("foo")[0].closest("button")!);
    expect(fsState.openFile).toHaveBeenCalledWith("/proj/src/a.ts", { line: 1 });
  });

  it("clicking a file-name hit row opens the file without a line", () => {
    renderWithQuery();
    fireEvent.click(screen.getByText("文件名匹配").closest("button")!);
    expect(fsState.openFile).toHaveBeenCalledWith("/proj/readme.md", undefined);
  });
});
