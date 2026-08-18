/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Project } from "../../bridge/tauri";

const { activateProjectMock } = vi.hoisted(() => ({
  activateProjectMock: vi.fn(),
}));

vi.mock("./activateProject", () => ({
  activateProject: activateProjectMock,
}));

import { ProjectRail } from "./ProjectRail";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useProjectStore } from "../../stores/project.store";

const projects: Project[] = Array.from({ length: 8 }, (_, index) => ({
  id: `p${index + 1}`,
  name: `项目 ${index + 1}`,
  path: `/tmp/project-${index + 1}`,
  created_at: 0,
  // Deliberately descending: this is the same order consumed by the dropdown.
  last_opened: 6 - index,
}));

beforeEach(() => {
  activateProjectMock.mockReset();
  useProjectStore.setState({ projects, activeProjectId: "p2" });
  useConversationStore.setState({
    conversationsByProject: Object.fromEntries(
      projects.map((project, index) => [
        project.id,
        [
          {
            id: `${project.id}-older`,
            project_id: project.id,
            title: "较早会话",
            agent_type: "nex",
            status: "active",
            created_at: 0,
            updated_at: index,
          },
          {
            id: `${project.id}-latest`,
            project_id: project.id,
            title: `${project.name} 的最新会话`,
            agent_type: "nex",
            status: "active",
            created_at: 0,
            updated_at: index + 100,
          },
        ],
      ]),
    ),
  });
  useAgentStore.setState({ sessions: {} });
});

afterEach(() => cleanup());

describe("ProjectRail", () => {
  it("shows the first seven projects in dropdown order and exposes their latest conversation", () => {
    const { container } = render(<ProjectRail />);
    const shortcuts = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="切换到项目"]',
    );

    expect(shortcuts).toHaveLength(7);
    expect(shortcuts[0]?.textContent).toBe("项");
    expect(shortcuts[6]?.getAttribute("aria-label")).toContain("项目 7 的最新会话");
    expect(container.textContent).toContain("项目 1");
    expect(container.textContent).toContain("项目 1 的最新会话");
    expect(container.textContent).not.toContain("项目 8 的最新会话");
    expect(shortcuts[1]?.getAttribute("aria-current")).toBe("page");
    const tooltip = container.querySelector<HTMLElement>("[role=tooltip]");
    expect(tooltip?.className).toContain("group-hover/project:visible");
    expect(tooltip?.className).toContain("group-focus-within/project:visible");
    expect(tooltip?.className).toContain("text-right");
    expect(tooltip?.querySelector(".text-\\[16px\\].font-bold")).toBeTruthy();
    expect(tooltip?.querySelector(".text-\\[13px\\]")).toBeTruthy();
  });

  it("keeps its order on a switch, then syncs the dropdown order when a new project enters", async () => {
    const { container } = render(<ProjectRail />);
    const shortcutNames = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label^="切换到项目"]')).map(
        (button) => button.getAttribute("aria-label")?.match(/^切换到项目 ([^，]+)/)?.[1],
      );

    expect(shortcutNames()).toEqual([
      "项目 1",
      "项目 2",
      "项目 3",
      "项目 4",
      "项目 5",
      "项目 6",
      "项目 7",
    ]);

    // Switching inside the existing seven only changes dropdown MRU order.
    act(() => {
      useProjectStore.setState({
        activeProjectId: "p3",
        projects: [projects[2], projects[0], projects[1], ...projects.slice(3)],
      });
    });
    await waitFor(() =>
      expect(shortcutNames()).toEqual([
        "项目 1",
        "项目 2",
        "项目 3",
        "项目 4",
        "项目 5",
        "项目 6",
        "项目 7",
      ]),
    );

    // Project 8 newly enters the dropdown's first seven, so the rail takes
    // the same first-seven ordering as the dropdown.
    act(() => {
      useProjectStore.setState({
        activeProjectId: "p8",
        projects: [projects[7], projects[2], projects[0], projects[1], ...projects.slice(3, 7)],
      });
    });
    await waitFor(() =>
      expect(shortcutNames()).toEqual([
        "项目 8",
        "项目 3",
        "项目 1",
        "项目 2",
        "项目 4",
        "项目 5",
        "项目 6",
      ]),
    );
  });

  it("uses a colored breathing monogram to show running and waiting work", () => {
    useAgentStore.setState({
      sessions: {
        "p1-latest": { sessionId: "s1", conversationId: "p1-latest", status: "running" },
        "p2-latest": { sessionId: "s2", conversationId: "p2-latest", status: "waiting" },
      },
    });
    const { container } = render(<ProjectRail />);
    const p1 = container.querySelector<HTMLButtonElement>('button[aria-label^="切换到项目 项目 1"]');
    const p2 = container.querySelector<HTMLButtonElement>('button[aria-label^="切换到项目 项目 2"]');

    expect(p1?.getAttribute("aria-label")).toContain("Agent 运行中");
    expect(p2?.getAttribute("aria-label")).toContain("Agent 等待中");
    expect(p1?.querySelector("span")?.className).toContain("animate-pulse");
    expect(p1?.querySelector("span")?.className).toContain("nex-project-running-rotate");
    expect(p1?.querySelector("span")?.className).toContain("text-[var(--success)]");
    expect(p1?.querySelector("span")?.className).toContain("font-bold");
    expect(p2?.querySelector("span")?.className).toContain("animate-pulse");
    expect(p2?.querySelector("span")?.className).toContain("text-[var(--warning)]");
    expect(p2?.querySelector("span")?.className).toContain("font-bold");
  });

  it("uses the shared project activation flow when a shortcut is clicked", () => {
    const { container } = render(<ProjectRail />);
    const first = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="切换到项目 项目 1"]',
    );

    if (!first) throw new Error("missing project shortcut");
    fireEvent.click(first);
    expect(activateProjectMock).toHaveBeenCalledWith(projects[0]);
  });
});
