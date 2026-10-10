// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProcessGroup } from "./ProcessGroup";
import { useToolCardExpansionStore } from "./toolCardExpansion";
import type { ProcessPart } from "./groupThreadEntries";
import type { ToolCallEntry } from "./types";

vi.mock("../../../stores/agent.store", () => ({
  useAgentStore: (sel: (s: unknown) => unknown) => sel({ respondPermission: vi.fn() }),
}));

const tool = (id: string, toolKind: string, title: string, status: ToolCallEntry["status"] = "completed"): ProcessPart => ({
  type: "tool",
  key: id,
  entry: { id, kind: "tool_call", toolCallId: id, toolKind, title, status, content: [], timestamp: 0 },
});
const thought = (key: string, text: string): ProcessPart => ({ type: "thought", key, text });

beforeEach(() => useToolCardExpansionStore.setState({ overrides: {} }));
afterEach(cleanup);

const parts = [
  thought("t0", "先看结构"),
  tool("a", "read", "Read README"),
  thought("t1", "再看模块"),
  tool("b", "search", "grep foo"),
];

it("shows the live step while the turn is still running", () => {
  render(<ProcessGroup parts={parts} active />);
  const toggle = screen.getAllByRole("button", { expanded: true })[0];
  expect(toggle.textContent).toContain("执行 · grep foo");
  // Body is open: the tool rows are visible.
  expect(screen.getByText("Read README")).toBeTruthy();
});

it("folds into one summary line once the turn has moved on", () => {
  render(<ProcessGroup parts={parts} active={false} />);
  const toggle = screen.getByRole("button", { expanded: false });
  expect(toggle.textContent).toContain("思考 2 次 · 工具调用 2 次");
  expect(screen.queryByText("Read README")).toBeNull();
});

it("collapses automatically when active turns false, unless the user opened it", () => {
  const { rerender } = render(<ProcessGroup parts={parts} active />);
  rerender(<ProcessGroup parts={parts} active={false} />);
  expect(screen.queryByText("Read README")).toBeNull();

  fireEvent.click(screen.getByRole("button", { expanded: false }));
  expect(screen.getByText("Read README")).toBeTruthy();
  rerender(<ProcessGroup parts={parts} active />);
  rerender(<ProcessGroup parts={parts} active={false} />);
  expect(screen.getByText("Read README")).toBeTruthy();
});

it("counts code edits in the summary", () => {
  render(
    <ProcessGroup
      parts={[tool("e", "edit", "Edit a.ts"), tool("r", "read", "Read b.ts")]}
      active={false}
    />,
  );
  expect(screen.getByRole("button", { expanded: false }).textContent).toContain(
    "代码修改 1 处",
  );
});

it("a lone reasoning block reads as 思考过程", () => {
  render(<ProcessGroup parts={[thought("t0", "hmm")]} active={false} />);
  expect(screen.getByRole("button", { expanded: false }).textContent).toContain("思考过程");
});
