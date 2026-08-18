/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  onCloseRequestedMock,
  destroyMock,
  appExitNowMock,
  closeRequestHandlers,
  appExitRequestedHandlers,
} = vi.hoisted(() => ({
  onCloseRequestedMock: vi
    .fn<(handler: (event: { preventDefault: () => void }) => void | Promise<void>) => Promise<() => void>>()
    .mockImplementation(async (handler) => {
      closeRequestHandlers.push(handler);
      return () => {};
    }),
  destroyMock: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  appExitNowMock: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  closeRequestHandlers: [] as Array<(event: { preventDefault: () => void }) => void | Promise<void>>,
  appExitRequestedHandlers: [] as Array<() => void>,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: (handler: (event: { preventDefault: () => void }) => void | Promise<void>) =>
      onCloseRequestedMock(handler),
    destroy: () => destroyMock(),
  }),
}));

vi.mock("@/bridge/tauri", () => ({
  appExitNow: () => appExitNowMock(),
  onAppExitRequested: async (cb: () => void) => {
    appExitRequestedHandlers.push(cb);
    return () => {};
  },
}));

vi.mock("../agent/CloseTabConfirmDialog", () => ({
  CloseTabConfirmDialog: () => null,
}));

import { AppLifecycleHost } from "./AppLifecycleHost";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useProjectStore } from "../../stores/project.store";
import { useUiStore } from "../../stores/ui.store";

beforeEach(() => {
  onCloseRequestedMock.mockClear();
  destroyMock.mockClear();
  appExitNowMock.mockClear();
  closeRequestHandlers.length = 0;
  appExitRequestedHandlers.length = 0;

  useUiStore.setState({ closeTabRequest: 0 });
  useProjectStore.setState({ activeProjectId: null });
  useConversationStore.setState({
    conversationsByProject: {},
    tabsByProject: {},
    activeTabByProject: {},
  });
  useAgentStore.setState({
    sessions: {},
    flushThreadSnapshots: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => cleanup());

describe("AppLifecycleHost quit confirmation", () => {
  it("intercepts close requests while an agent is busy and opens the quit dialog", async () => {
    useAgentStore.setState({
      sessions: {
        c1: { sessionId: "s1", conversationId: "c1", status: "running" },
      },
    });

    render(<AppLifecycleHost />);
    await waitFor(() => expect(onCloseRequestedMock).toHaveBeenCalledTimes(1));

    const event = { preventDefault: vi.fn() };
    await act(async () => {
      await closeRequestHandlers[0]?.(event);
    });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("quit-confirm-dialog")).toBeTruthy();
    expect(screen.getByText("退出应用？")).toBeTruthy();
  });

  it("shows the same confirmation when macOS Cmd+Q requests an app exit", async () => {
    useAgentStore.setState({
      sessions: {
        c1: { sessionId: "s1", conversationId: "c1", status: "running" },
      },
    });

    render(<AppLifecycleHost />);
    await waitFor(() => expect(onCloseRequestedMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      appExitRequestedHandlers[0]?.();
    });

    expect(appExitNowMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("quit-confirm-dialog")).toBeTruthy();
  });

  it("lets close requests pass through when no agent is busy", async () => {
    render(<AppLifecycleHost />);
    await waitFor(() => expect(onCloseRequestedMock).toHaveBeenCalledTimes(1));

    const event = { preventDefault: vi.fn() };
    await act(async () => {
      await closeRequestHandlers[0]?.(event);
    });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByTestId("quit-confirm-dialog")).toBeNull();

    await act(async () => {
      appExitRequestedHandlers[0]?.();
    });
    await waitFor(() => expect(appExitNowMock).toHaveBeenCalledTimes(1));
  });

  it("confirms quit by flushing snapshots and exiting the app", async () => {
    const flushThreadSnapshots = vi.fn().mockResolvedValue(undefined);
    useAgentStore.setState({
      sessions: {
        c1: { sessionId: "s1", conversationId: "c1", status: "waiting" },
      },
      flushThreadSnapshots,
    });

    render(<AppLifecycleHost />);
    await waitFor(() => expect(onCloseRequestedMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await closeRequestHandlers[0]?.({ preventDefault: vi.fn() });
    });
    fireEvent.click(screen.getByRole("button", { name: "退出并中断" }));

    await waitFor(() => expect(flushThreadSnapshots).toHaveBeenCalledTimes(1));
    expect(appExitNowMock).toHaveBeenCalledTimes(1);
  });
});
