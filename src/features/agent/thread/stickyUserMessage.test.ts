import { describe, expect, it } from "vitest";
import { pickStickyUserMessage, type UserStickyCandidate } from "./stickyUserMessage";

const A: UserStickyCandidate = { index: 0, id: "a", start: 0, height: 80 };
const B: UserStickyCandidate = { index: 4, id: "b", start: 400, height: 80 };
const C: UserStickyCandidate = { index: 8, id: "c", start: 900, height: 100 };

describe("pickStickyUserMessage", () => {
  it("顶部不吸顶", () => {
    expect(pickStickyUserMessage([A, B], 0)).toBeNull();
  });

  it("空列表不吸顶", () => {
    expect(pickStickyUserMessage([], 100)).toBeNull();
  });

  it("尚未滚过任何用户消息时不吸顶", () => {
    expect(pickStickyUserMessage([B, C], 100)).toBeNull();
  });

  it("滚过一条后吸顶该条", () => {
    expect(pickStickyUserMessage([A, B, C], 50)).toEqual({
      id: "a",
      index: 0,
      translateY: 0,
    });
  });

  it("同时只吸顶最近一条已滚过的用户消息", () => {
    expect(pickStickyUserMessage([A, B, C], 500)).toEqual({
      id: "b",
      index: 4,
      translateY: 0,
    });
  });

  it("下一条靠近顶部时把当前条向上顶出", () => {
    // B.height=80, next.start=900, scrollTop=860 → gap=40 < 80 → translateY=-40
    expect(pickStickyUserMessage([A, B, C], 860)).toEqual({
      id: "b",
      index: 4,
      translateY: -40,
    });
  });

  it("下一条到达顶部后切换为下一条", () => {
    expect(pickStickyUserMessage([A, B, C], 900)).toEqual({
      id: "c",
      index: 8,
      translateY: 0,
    });
  });
});
