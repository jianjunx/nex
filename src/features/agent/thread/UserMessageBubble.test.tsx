/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { UserMessageBubble } from "./UserMessageBubble";
import { USER_MESSAGE_COLLAPSE_HEIGHT } from "./stickyUserMessage";
import type { UserMessageEntry } from "./types";

const ENTRY: UserMessageEntry = {
  id: "u1",
  kind: "user_message",
  text: "hello world",
  timestamp: 1,
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("UserMessageBubble", () => {
  it("内容未超高时不显示展开", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(80);
    render(<UserMessageBubble entry={ENTRY} expanded={false} onToggleExpand={() => {}} />);
    expect(screen.queryByRole("button", { name: "展开" })).toBeNull();
  });

  it("renders file tokens as @文件名 in the bubble", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(80);
    render(
      <UserMessageBubble
        entry={{ ...ENTRY, text: "请看 @[src/features/agent/ComposerEditor.tsx]" }}
        expanded={false}
        onToggleExpand={() => {}}
      />,
    );
    expect(screen.getByText("请看 @ComposerEditor.tsx")).toBeTruthy();
  });

  it("内容超过 170px 时折叠并显示展开", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
    const { container } = render(
      <UserMessageBubble entry={ENTRY} expanded={false} onToggleExpand={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "展开" })).toBeTruthy();
    const body = container.querySelector("[data-user-msg-body]");
    expect(body).toBeTruthy();
    expect((body as HTMLElement).style.maxHeight).toBe(`${USER_MESSAGE_COLLAPSE_HEIGHT}px`);
  });

  it("展开后去掉高度限制并显示收起", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
    const onToggle = vi.fn();
    const { container } = render(
      <UserMessageBubble entry={ENTRY} expanded onToggleExpand={onToggle} />,
    );
    expect(screen.getByRole("button", { name: "收起" })).toBeTruthy();
    const body = container.querySelector("[data-user-msg-body]") as HTMLElement;
    expect(body.style.maxHeight).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
