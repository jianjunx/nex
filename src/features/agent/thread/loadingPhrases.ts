import type { ThreadEntry } from "./types";

/**
 * 等待态文案。按"刚发生了什么"分组，让等待有进展感；
 * 措辞只陈述我们确实知道的事（上一步是读文件/跑命令/出错…），
 * 不编造 agent 此刻在分析什么。
 */
export type LoadingContext =
  | "start"
  | "after_read"
  | "after_edit"
  | "after_run"
  | "after_failed"
  | "after_other"
  | "after_plan"
  | "after_answer";

export const LOADING_ROTATE_MS = 5000;
/** 连续轮换这么多次（≈15s）仍在等，就换成"久等"文案。 */
export const LONG_WAIT_TICKS = 3;

const PHRASES: Record<LoadingContext, readonly string[]> = {
  start: [
    "正在理解你的需求…",
    "正在梳理思路…",
    "脑细胞正在加班…",
    "先想清楚，再动手…",
    "正在琢磨最稳妥的做法…",
  ],
  after_read: [
    "刚看完资料，正在消化…",
    "线索收集得差不多了，正在串起来…",
    "正在把看到的内容对上号…",
    "读完了，正在想怎么下手…",
  ],
  after_edit: [
    "改动已落笔，正在想下一步…",
    "改完了，正在确认没有遗漏…",
    "代码已写入，正在复盘一下…",
  ],
  after_run: [
    "命令跑完了，正在读输出…",
    "正在解读终端的回答…",
    "结果出来了，正在判断下一步…",
  ],
  after_failed: [
    "刚才碰了个钉子，正在换条路…",
    "遇到点小状况，正在想办法绕过去…",
    "这条路不通，正在重新规划…",
  ],
  after_other: [
    "拿到结果了，正在思考下一步…",
    "正在消化刚拿到的信息…",
    "正在权衡接下来怎么走…",
  ],
  after_plan: ["计划已确认，正在开工…", "收到，正在按计划动手…"],
  after_answer: ["收到你的选择，正在继续…", "谢谢回答，正在接着往下做…"],
};

const LONG_WAIT: readonly string[] = [
  "这个问题有点深，再给我一点时间…",
  "还在认真想，没有偷懒…",
  "复杂的事值得多想一会儿…",
  "好饭不怕晚，马上就好…",
];

const FALLBACK = "正在思考…";

/** 由线程末尾条目推断此刻"刚发生了什么"。仅看最后一条，O(1)。 */
export function loadingContextFor(entries: readonly ThreadEntry[]): LoadingContext {
  const last = entries[entries.length - 1];
  if (!last) return "start";
  switch (last.kind) {
    case "tool_call": {
      if (last.status === "failed") return "after_failed";
      switch (last.toolKind.toLowerCase()) {
        case "read":
        case "search":
        case "fetch":
          return "after_read";
        case "edit":
        case "delete":
        case "move":
          return "after_edit";
        case "execute":
          return "after_run";
        default:
          return "after_other";
      }
    }
    case "plan_approval":
      return "after_plan";
    case "ask_question":
      return "after_answer";
    default:
      return "start";
  }
}

/**
 * 选一条文案。`tick` 为已等待的轮换次数，`seed` 让不同次等待从不同位置开始，
 * 避免每次都先看到同一句。纯函数，便于测试。
 */
export function pickLoadingPhrase(context: LoadingContext, tick: number, seed: number): string {
  const safeTick = Math.max(0, Math.floor(tick));
  const safeSeed = Math.max(0, Math.floor(seed));
  if (safeTick >= LONG_WAIT_TICKS) {
    return LONG_WAIT[(safeSeed + safeTick - LONG_WAIT_TICKS) % LONG_WAIT.length] ?? FALLBACK;
  }
  const pool = PHRASES[context];
  return pool[(safeSeed + safeTick) % pool.length] ?? FALLBACK;
}

export const LOADING_PHRASE_POOLS = { contexts: PHRASES, longWait: LONG_WAIT } as const;
