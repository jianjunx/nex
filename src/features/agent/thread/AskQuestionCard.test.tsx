/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const respondAskQuestion = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../stores/agent.store", () => ({
  useAgentStore: (selector: (s: { respondAskQuestion: typeof respondAskQuestion }) => unknown) =>
    selector({ respondAskQuestion }),
}));

import { AskQuestionCard } from "./AskQuestionCard";
import type { AskQuestionEntry } from "./types";

const ENTRY: AskQuestionEntry = {
  id: "card-1",
  kind: "ask_question",
  timestamp: 1,
  requestId: "ask-1",
  title: "需要登录凭证才能访问该系统，你想怎么继续？",
  questions: [
    {
      id: "q1",
      prompt: "需要登录凭证才能访问该系统，你想怎么继续？",
      options: [
        { id: "a", label: "我提供测试账号密码", description: "你直接在回复中提供工号和密码" },
        { id: "b", label: "我手动登录后继续", description: "你自己在浏览器中完成登录" },
      ],
      allowMultiple: false,
    },
  ],
  status: "pending",
};

describe("AskQuestionCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    respondAskQuestion.mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it("单选点击选项立即提交", () => {
    render(<AskQuestionCard entry={ENTRY} />);
    fireEvent.click(screen.getByText("我提供测试账号密码"));
    expect(respondAskQuestion).toHaveBeenCalledWith("ask-1", "answered", [
      { questionId: "q1", selectedOptionIds: ["a"] },
    ]);
  });

  it("跳过会以 skipped 回传", () => {
    render(<AskQuestionCard entry={ENTRY} />);
    fireEvent.click(screen.getByText("跳过"));
    expect(respondAskQuestion).toHaveBeenCalledWith("ask-1", "skipped", undefined);
  });

  it("已回答时显示状态且不再可点", () => {
    render(
      <AskQuestionCard
        entry={{
          ...ENTRY,
          status: "answered",
          answers: [{ questionId: "q1", selectedOptionIds: ["b"] }],
        }}
      />,
    );
    expect(screen.getByText("已回答")).toBeTruthy();
    expect(screen.queryByText("跳过")).toBeNull();
    fireEvent.click(screen.getByText("我手动登录后继续"));
    expect(respondAskQuestion).not.toHaveBeenCalled();
  });
});
