import { describe, expect, it } from "vitest";
import { groupChunks } from "./groupChunks";

describe("groupChunks", () => {
  it("合并相邻同类型 chunk", () => {
    const grouped = groupChunks([
      { type: "message", text: "Hel" },
      { type: "message", text: "lo" },
      { type: "thought", text: "hmm" },
      { type: "message", text: "world" },
    ]);
    expect(grouped).toEqual([
      { type: "message", text: "Hello" },
      { type: "thought", text: "hmm" },
      { type: "message", text: "world" },
    ]);
  });

  it("返回新对象,不修改输入", () => {
    const input = [{ type: "message" as const, text: "a" }];
    const grouped = groupChunks(input);
    expect(grouped[0]).not.toBe(input[0]);
    grouped[0].text += "x";
    expect(input[0].text).toBe("a");
  });

  it("空输入返回空数组", () => {
    expect(groupChunks([])).toEqual([]);
  });
});
