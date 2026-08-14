/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAgentStore } from "../../stores/agent.store";
import { ComposerStatusNotice } from "./ComposerStatusNotice";

beforeEach(() => {
  useAgentStore.setState({ errorsByConversation: {} });
});

afterEach(() => {
  cleanup();
  useAgentStore.setState({ errorsByConversation: {} });
});

describe("ComposerStatusNotice", () => {
  it("shows only the active conversation's error and dismisses only that error", () => {
    useAgentStore.setState({
      errorsByConversation: {
        "conversation-a": "会话 A 的错误",
        "conversation-b": "会话 B 的错误",
      },
    });
    const { rerender } = render(
      <ComposerStatusNotice conversationId="conversation-a" isStarting={false} />,
    );

    expect(screen.getByRole("alert").textContent).toContain("会话 A 的错误");
    expect(screen.queryByText("会话 B 的错误")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    expect(useAgentStore.getState().errorsByConversation).toEqual({
      "conversation-b": "会话 B 的错误",
    });

    rerender(<ComposerStatusNotice conversationId="conversation-b" isStarting={false} />);
    expect(screen.getByRole("alert").textContent).toContain("会话 B 的错误");
  });
});
