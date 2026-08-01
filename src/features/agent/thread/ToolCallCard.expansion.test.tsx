/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToolCallCard } from "./ToolCallCard";
import { useToolCardExpansionStore } from "./toolCardExpansion";
import type { ToolCallEntry } from "./types";

// 本测试只用文本内容卡,不触发 CodeMirror;mock 掉保持轻量。
vi.mock("./ThreadDiffBlock", () => ({ ThreadDiffBlock: () => <div data-testid="diff" /> }));
vi.mock("../../../stores/agent.store", () => ({
  useAgentStore: (sel: (s: { respondPermission: () => void }) => unknown) =>
    sel({ respondPermission: () => {} }),
}));

const entry: ToolCallEntry = {
  id: "t1",
  toolCallId: "tc1",
  kind: "tool_call",
  toolKind: "read",
  title: "Read File",
  status: "completed",
  content: [{ type: "text", text: "结果" }],
  timestamp: 1,
};

beforeEach(() => useToolCardExpansionStore.setState({ overrides: {} }));
afterEach(() => cleanup());

describe("ToolCallCard 展开态外提", () => {
  it("手动展开的状态在卸载重挂后还原", () => {
    const { unmount } = render(<ToolCallCard entry={entry} />);
    expect(screen.queryByText("结果")).toBeNull(); // 非 edit 默认收起

    fireEvent.click(screen.getByText("Read File"));
    expect(screen.getByText("结果")).toBeTruthy();
    unmount();

    render(<ToolCallCard entry={entry} />);
    expect(screen.getByText("结果")).toBeTruthy(); // 重挂后仍展开
  });
});
