/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
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

const projects: Project[] = Array.from({ length: 6 }, (_, index) => ({
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
  it("shows the first five projects in dropdown order and exposes their latest conversation", () => {
    const { container } = render(<ProjectRail />);
    const shortcuts = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="切换到项目"]',
    );

    expect(shortcuts).toHaveLength(5);
    expect(shortcuts[0]?.textContent).toBe("项");
    expect(shortcuts[4]?.getAttribute("aria-label")).toContain("项目 5 的最新会话");
    expect(container.textContent).toContain("项目 1");
    expect(container.textContent).toContain("项目 1 的最新会话");
    expect(container.textContent).not.toContain("项目 6 的最新会话");
    expect(shortcuts[1]?.getAttribute("aria-current")).toBe("page");
    const tooltip = container.querySelector<HTMLElement>("[role=tooltip]");
    expect(tooltip?.className).toContain("group-hover/project:visible");
    expect(tooltip?.className).toContain("group-focus-within/project:visible");
    expect(tooltip?.className).toContain("text-right");
    expect(tooltip?.querySelector(".text-\\[14px\\]")).toBeTruthy();
    expect(tooltip?.querySelector(".text-\\[13px\\]")).toBeTruthy();
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
