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

beforeEach(() => {
  useToolCardExpansionStore.setState({ overrides: {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const parts = [
  thought("t0", "先看结构"),
  tool("a", "read", "Read README"),
  thought("t1", "再看模块"),
  tool("b", "search", "grep foo", "in_progress"),
];

it("shows the live step while the turn is still running", () => {
  render(<ProcessGroup parts={parts} active />);
  const toggle = screen.getAllByRole("button", { expanded: false })[0];
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

it("keeps only the running tool and its predecessor mounted as calls accumulate", () => {
  const { rerender } = render(<ProcessGroup parts={[tool("a", "read", "first", "in_progress")]} active />);
  expect(screen.getByText("first")).toBeTruthy();
  rerender(<ProcessGroup parts={[
    tool("a", "read", "first"), tool("b", "read", "second", "pending"),
  ]} active />);
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.getByText("second")).toBeTruthy();

  const many = Array.from({ length: 100 }, (_, i) =>
    tool(`call-${i}`, "execute", `command-${i}`, i === 99 ? "in_progress" : "completed"));
  rerender(<ProcessGroup parts={many} active />);
  expect(screen.queryByText("command-0")).toBeNull();
  expect(screen.queryByText("command-97")).toBeNull();
  expect(screen.getByText("command-98")).toBeTruthy();
  expect(screen.getByText("command-99")).toBeTruthy();
  expect(screen.getAllByRole("button")).toHaveLength(3);

  rerender(<ProcessGroup parts={many.map((p) => p.type === "tool"
    ? { ...p, entry: { ...p.entry, status: "completed" } } : p)} active />);
  expect(screen.queryByText("command-98")).toBeNull();
  expect(screen.queryByText("command-99")).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(1);
});

it("lets the user expand older calls without hiding the live pair", () => {
  render(<ProcessGroup parts={[
    tool("a", "read", "first"),
    thought("t", "older reasoning"),
    tool("b", "read", "second"),
    tool("c", "read", "current", "in_progress"),
  ]} active />);
  expect(screen.queryByText("first")).toBeNull();
  expect(screen.queryByText("older reasoning")).toBeNull();
  const header = screen.getAllByRole("button")[0];
  fireEvent.click(header);
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.getByText("second")).toBeTruthy();
  expect(screen.getByText("current")).toBeTruthy();
  fireEvent.click(header);
  expect(screen.queryByText("first")).toBeNull();
  expect(screen.getByText("second")).toBeTruthy();
  expect(screen.getByText("current")).toBeTruthy();
});

it("keeps parallel running calls and permission prompts visible", () => {
  render(<ProcessGroup parts={[
    tool("a", "read", "slow task", "in_progress"),
    tool("b", "read", "older finished"),
    tool("c", "read", "last finished", "failed"),
    tool("d", "read", "awaiting permission", "waiting_for_confirmation"),
    tool("e", "read", "queued", "pending"),
  ]} active />);
  expect(screen.getByText("slow task")).toBeTruthy();
  expect(screen.queryByText("older finished")).toBeNull();
  expect(screen.getByText("last finished")).toBeTruthy();
  expect(screen.getByText("awaiting permission")).toBeTruthy();
  expect(screen.getByText("queued")).toBeTruthy();
});

it("keeps current reasoning visible after completed tools fold", () => {
  render(<ProcessGroup parts={[
    tool("a", "read", "finished"), thought("t", "still thinking"),
  ]} active />);
  expect(screen.queryByText("finished")).toBeNull();
  expect(screen.getByText("still thinking")).toBeTruthy();
});
