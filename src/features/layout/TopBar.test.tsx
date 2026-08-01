/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// TopBar 触碰 Tauri 窗口 API 与重子组件；全部打桩。被测的页签轮廓是纯
// className 逻辑，store 用真实例 + setState 播种。
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    isFullscreen: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("../projects/ProjectSelector", () => ({
  ProjectSelector: () => <div data-testid="project-selector" />,
}));
vi.mock("./WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../agent/CloseTabConfirmDialog", () => ({
  CloseTabConfirmDialog: () => null,
}));

import { TopBar } from "./TopBar";
import { useProjectStore } from "../../stores/project.store";
import { useConversationStore } from "../../stores/conversation.store";

beforeEach(() => {
  useProjectStore.setState({
    projects: [{ id: "p1", name: "demo", path: "/tmp/demo", created_at: 0, last_opened: 0 }],
    activeProjectId: "p1",
  });
  useConversationStore.setState({
    conversationsByProject: {
      p1: [
        { id: "c1", project_id: "p1", title: "第一个会话", agent_type: "x", status: "active", created_at: 0, updated_at: 0 },
        { id: "c2", project_id: "p1", title: "第二个会话", agent_type: "x", status: "active", created_at: 0, updated_at: 0 },
      ],
    },
    tabsByProject: { p1: ["c1", "c2"] },
    activeTabByProject: { p1: "c1" },
  });
});
afterEach(() => cleanup());

describe("conversation tab outline (F5)", () => {
  it("active trigger carries capsule outline classes (glass bg, border, top highlight, left accent bar)", () => {
    render(<TopBar />);
    const active = screen.getByRole("tab", { name: /第一个会话/ });
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:bg-[var(--glass-2-surface)]"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:border-[color:var(--border-default)]"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:before:w-0.5"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:before:opacity-100"
    );
    expect(active.className).toContain("rounded-[var(--radius-md)]");
    // line 变体内置 after 下划线保持关闭
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-0"
    );
    // dark 对偶类必须在场（R1：顶掉 ui/tabs.tsx 内置 dark:bg-transparent/border-transparent）
    expect(active.className).toContain(
      "dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-[var(--glass-2-surface)]"
    );
    expect(active.className).toContain(
      "dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-[color:var(--border-default)]"
    );
  });

  it("legacy bottom-line shadow and small radius are gone", () => {
    render(<TopBar />);
    const active = screen.getByRole("tab", { name: /第一个会话/ });
    expect(active.className).not.toContain("shadow-[inset_0_-2px_0_0_var(--accent)]");
    expect(active.className).not.toContain("rounded-[var(--radius-sm)]");
  });

  it("inactive triggers keep transparent placeholder border + hover lift/bg/border", () => {
    render(<TopBar />);
    const inactive = screen.getByRole("tab", { name: /第二个会话/ });
    expect(inactive.className).toContain("border-transparent");
    expect(inactive.className).toContain("hover:-translate-y-px");
    expect(inactive.className).toContain(
      "group-data-[variant=line]/tabs-list:hover:bg-[var(--overlay-hover)]"
    );
    expect(inactive.className).toContain("hover:border-[color:var(--border-subtle)]");
    // 激活 hover 不位移的覆盖类也在同一 class 集里
    expect(inactive.className).toContain("data-[state=active]:hover:translate-y-0");
  });

  it("renders scrollbar-hidden overflow with left/right fade masks", () => {
    const { container } = render(<TopBar />);
    expect(container.innerHTML).toContain("overflow-x-auto scrollbar-none");
    expect(container.innerHTML).toContain("bg-gradient-to-r from-[var(--glass-1-surface)] to-transparent");
    expect(container.innerHTML).toContain("bg-gradient-to-l from-[var(--glass-1-surface)] to-transparent");
    expect(container.innerHTML).toContain("pointer-events-none");
  });
});
