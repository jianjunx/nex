/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlanBar } from "./PlanBar";
import type { PlanEntry } from "./types";

const ENTRIES: PlanEntry[] = [
  { content: "检查线程渲染", priority: "high", status: "completed" },
  { content: "把 Plan 默认折叠", priority: "high", status: "in_progress" },
  { content: "补测试并验证", priority: "medium", status: "pending" },
];

afterEach(() => {
  cleanup();
});

describe("PlanBar", () => {
  it("默认折叠计划列表，只显示摘要", () => {
    render(<PlanBar entries={ENTRIES} />);

    const toggle = screen.getByRole("button", { name: /Plan/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(screen.queryByText("把 Plan 默认折叠")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("点击标题后展开计划列表", () => {
    render(<PlanBar entries={ENTRIES} />);

    const toggle = screen.getByRole("button", { name: /Plan/i });
    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("list")).toBeTruthy();
    expect(screen.getByText("检查线程渲染")).toBeTruthy();
    expect(screen.getByText("把 Plan 默认折叠")).toBeTruthy();
    expect(screen.getByText("补测试并验证")).toBeTruthy();
  });
});
