import { describe, expect, it } from "vitest";
import {
  LONG_WAIT_TICKS,
  LOADING_PHRASE_POOLS,
  loadingContextFor,
  pickLoadingPhrase,
  type LoadingContext,
} from "./loadingPhrases";
import type { ThreadEntry, ToolCallEntry } from "./types";

function tool(toolKind: string, status: ToolCallEntry["status"] = "completed"): ToolCallEntry {
  return {
    id: "t",
    kind: "tool_call",
    toolCallId: "t",
    title: "x",
    toolKind,
    status,
    content: [],
    timestamp: 1,
  };
}

const user: ThreadEntry = { id: "u", kind: "user_message", text: "hi", timestamp: 1 };

describe("loadingContextFor", () => {
  it.each([
    ["空线程", [], "start"],
    ["刚发出用户消息", [user], "start"],
    ["读完文件", [user, tool("read")], "after_read"],
    ["搜索完", [user, tool("search")], "after_read"],
    ["编辑完", [user, tool("edit")], "after_edit"],
    ["命令跑完", [user, tool("execute")], "after_run"],
    ["未知工具", [user, tool("other")], "after_other"],
    ["工具失败（无论什么类型）", [user, tool("read", "failed")], "after_failed"],
  ] as [string, ThreadEntry[], LoadingContext][])("%s → %s", (_name, entries, expected) => {
    expect(loadingContextFor(entries)).toBe(expected);
  });

  it("recognises a just-approved plan and an answered question", () => {
    const plan: ThreadEntry = {
      id: "p",
      kind: "plan_approval",
      requestId: "r",
      plan: "x",
      todos: [],
      status: "accepted",
      timestamp: 1,
    };
    const ask: ThreadEntry = {
      id: "a",
      kind: "ask_question",
      requestId: "r2",
      questions: [],
      status: "answered",
      timestamp: 1,
    };
    expect(loadingContextFor([user, plan])).toBe("after_plan");
    expect(loadingContextFor([user, ask])).toBe("after_answer");
  });
});

describe("pickLoadingPhrase", () => {
  const contexts = Object.keys(LOADING_PHRASE_POOLS.contexts) as LoadingContext[];

  it("is deterministic for the same (context, tick, seed)", () => {
    for (const c of contexts) {
      expect(pickLoadingPhrase(c, 1, 7)).toBe(pickLoadingPhrase(c, 1, 7));
    }
  });

  it("returns a phrase from the context pool before the long-wait threshold", () => {
    for (const c of contexts) {
      for (let tick = 0; tick < LONG_WAIT_TICKS; tick++) {
        expect(LOADING_PHRASE_POOLS.contexts[c]).toContain(pickLoadingPhrase(c, tick, 3));
      }
    }
  });

  it("switches to reassuring long-wait phrases after the threshold, whatever the context", () => {
    for (const c of contexts) {
      expect(LOADING_PHRASE_POOLS.longWait).toContain(pickLoadingPhrase(c, LONG_WAIT_TICKS, 0));
      expect(LOADING_PHRASE_POOLS.longWait).toContain(pickLoadingPhrase(c, LONG_WAIT_TICKS + 50, 9));
    }
  });

  it("rotates: consecutive ticks give different phrases while the pool has more than one", () => {
    const first = pickLoadingPhrase("start", 0, 0);
    const second = pickLoadingPhrase("start", 1, 0);
    expect(second).not.toBe(first);
  });

  it("varies the starting phrase with the seed", () => {
    const starts = new Set([0, 1, 2, 3].map((seed) => pickLoadingPhrase("start", 0, seed)));
    expect(starts.size).toBeGreaterThan(1);
  });

  it("never throws or returns an empty string for odd inputs", () => {
    for (const c of contexts) {
      for (const [tick, seed] of [[-1, -1], [1.7, 2.2], [1e9, 1e9], [Number.NaN, Number.NaN]]) {
        expect(pickLoadingPhrase(c, tick, seed).length).toBeGreaterThan(0);
      }
    }
  });

  it("has no empty or duplicated phrases within a pool", () => {
    for (const pool of [...Object.values(LOADING_PHRASE_POOLS.contexts), LOADING_PHRASE_POOLS.longWait]) {
      expect(pool.every((p) => p.trim().length > 0)).toBe(true);
      expect(new Set(pool).size).toBe(pool.length);
    }
  });
});
