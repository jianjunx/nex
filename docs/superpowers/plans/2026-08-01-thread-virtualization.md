# 会话消息流虚拟渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `ThreadView` 消息流接入 `@tanstack/react-virtual` 虚拟滚动,配合条目 memo 化、订阅收窄与 diff 延迟挂载,消除长会话(上千条 + 大量展开 edit 卡)的滚动卡顿。

**Architecture:** 数据层(Rust 事件 → agent.store)完全不动;视图层改为"订阅当前会话 entries 数组 → useMemo 分组 → useVirtualizer 窗口渲染 → memo 化条目组件"。immer 结构共享保证未变条目引用稳定,逐 token 流式更新只重渲染末尾一行;工具卡展开状态外提到独立 store,跨虚拟化卸载/重挂不丢失。

**Tech Stack:** React 19、zustand 5(+immer)、@tanstack/react-virtual 3.14.8(已在依赖,首次落地)、vitest + @testing-library/react、Tauri 2(不涉及 Rust 侧改动)

**Spec:** `docs/superpowers/specs/2026-08-01-thread-virtualization-design.md`

## Global Constraints

- 不新增任何依赖;`@tanstack/react-virtual` 已在 package.json
- 数据层(`src-tauri/`、`src/stores/agent.store.ts` 的事件处理与 `applySessionUpdate`)不改
- 流式节流(rAF 合批)不在本期范围,不做
- 接受虚拟化固有限制:离屏消息无 DOM,不保证跨多屏选择与原生页内查找
- 代码注释与 UI 文案沿用仓库现有风格(中文注释)
- 提交信息沿用仓库 conventional 风格(如 `perf(ui): …`、`refactor(ui): …`、`test(ui): …`),结尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`
- 每个任务结束前:`pnpm exec tsc -b` 与 `pnpm exec vitest run <涉及文件>` 全绿,`pnpm lint` 无新告警
- 工作区存在无关未提交改动(`ThreadView.tsx` 气泡宽度),**不要** `git add -A`;每个任务只 add 自己改的文件

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/components/ui/card.tsx` | 通用卡片;删掉无效 `backdrop-blur-xl` | 修改 |
| `src/features/agent/thread/groupChunks.ts` | 相邻同类型 assistant chunk 合并(纯函数) | 新增 |
| `src/features/agent/thread/groupChunks.test.ts` | groupChunks 单测 | 新增 |
| `src/features/agent/thread/EntryView.tsx` | 单条 entry 渲染(memo 化),自 ThreadView 拆出 | 新增 |
| `src/features/agent/thread/ThreadView.tsx` | 列表容器:订阅收窄、分组 memo、虚拟化、贴底 | 修改 |
| `src/features/agent/thread/toolCardExpansion.ts` | 工具卡展开状态外提 store | 新增 |
| `src/features/agent/thread/toolCardExpansion.test.ts` | 展开状态 store 单测 | 新增 |
| `src/features/agent/thread/ToolCallCard.tsx` | 工具卡:读写外提展开态;组 key 修复配套 | 修改 |
| `src/features/agent/thread/ToolCallCard.expansion.test.tsx` | 展开态跨卸载/重挂还原测试 | 新增 |
| `src/features/agent/thread/groupThreadEntries.ts` | tool_group key 改首个 id | 修改 |
| `src/features/agent/thread/groupThreadEntries.test.ts` | 追加 key 稳定性测试 | 修改 |
| `src/features/agent/thread/threadTestUtils.tsx` | 测试基建:jsdom 布局 mock + store 播种 + 性能种子数据 | 新增 |
| `src/features/agent/thread/ThreadView.virtual.test.tsx` | 窗口化 / 跟随 / 取消跟随 / 切 tab 组件测试 | 新增 |
| `src/features/agent/thread/ThreadView.crosstalk.test.tsx` | 订阅收窄:后台会话更新不重渲染前台 | 新增 |
| `src/stores/agent.store.test.ts` | 追加 immer 结构共享前提测试 | 修改 |
| `src/features/agent/thread/ThreadDiffBlock.tsx` | CodeMirror 延迟挂载 | 修改 |
| `src/features/agent/thread/ThreadDiffBlock.test.tsx` | 适配延迟挂载 + 新增占位/卸载测试 | 修改 |
| `src/stores/conversation.store.ts` | `loadMessages` offset 分页循环 | 修改 |
| `src/stores/conversation.store.test.ts` | 追加分页测试 | 修改 |
| `src/App.tsx` | 临时 DEV 种子入口(验证后删除) | 修改(临时) |

---

### Task 1: 移除 Card 无效模糊层

**Files:**
- Modify: `src/components/ui/card.tsx:10`

**Interfaces:**
- Consumes: 无
- Produces: 无(纯视觉,接口不变)

- [ ] **Step 1: 删除 backdrop-blur-xl**

`src/components/ui/card.tsx` 第 10 行,`Card` 的 className 中删除 `backdrop-blur-xl`:

```tsx
        "flex flex-col gap-6 rounded-xl border border-[color:var(--glass-border)] bg-[var(--glass-2-surface)] py-6 text-card-foreground shadow-none",
```

理由:玻璃表面已是不透明纯色(`--glass-2-surface`),模糊零视觉效果,但滚动时每张卡片各产生一个 backdrop-filter 合成层。

- [ ] **Step 2: 跑全量测试确认无回归**

Run: `pnpm exec vitest run`
Expected: 全绿(现有测试不依赖该 class)

- [ ] **Step 3: 手动验证视觉无变化**

Run: `pnpm dev`,打开任一有历史消息的会话,确认消息气泡外观与之前一致(本就不透明,应看不出差别)。

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/card.tsx
git commit -m "perf(ui): 移除 Card 无效的 backdrop-blur-xl 合成层

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: groupChunks 提取 + EntryView 拆分并 memo 化

**Files:**
- Create: `src/features/agent/thread/groupChunks.ts`
- Create: `src/features/agent/thread/groupChunks.test.ts`
- Create: `src/features/agent/thread/EntryView.tsx`
- Modify: `src/features/agent/thread/ThreadView.tsx`(删除 `EntryView`、`groupChunks` 两个函数定义,改 import)

**Interfaces:**
- Produces:
  - `groupChunks(chunks: AssistantChunk[]): AssistantChunk[]` —— 相邻同类型合并,返回新对象
  - `EntryView: React.MemoExoticComponent<({ entry }: { entry: ThreadEntry }) => JSX>` —— 命名导出

- [ ] **Step 1: 写 groupChunks 失败测试**

Create `src/features/agent/thread/groupChunks.test.ts`:

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/features/agent/thread/groupChunks.test.ts`
Expected: FAIL,`Cannot find module './groupChunks'`

- [ ] **Step 3: 实现 groupChunks.ts**

Create `src/features/agent/thread/groupChunks.ts`:

```ts
import type { AssistantChunk } from "./types";

/** 合并相邻同类型 chunk,减少 Markdown 渲染块数量。返回新对象,不改输入。 */
export function groupChunks(chunks: AssistantChunk[]): AssistantChunk[] {
  const out: AssistantChunk[] = [];
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && last.type === c.type) last.text += c.text;
    else out.push({ ...c });
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/features/agent/thread/groupChunks.test.ts`
Expected: PASS(3 个)

- [ ] **Step 5: 拆出 EntryView.tsx 并 memo 化**

Create `src/features/agent/thread/EntryView.tsx`。内容 = 现 `ThreadView.tsx` 中 `function EntryView`(约 139-206 行)整体搬出,做三处调整:① 用 `memo` 包裹;② 助手消息分支的 `groupChunks` 结果包 `useMemo`;③ 导入从新位置写:

```tsx
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { ListChecks } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { groupChunks } from "./groupChunks";
import type { ThreadEntry } from "./types";

/**
 * 单条线程条目渲染。memo 化依赖 entry 引用稳定(immer 结构共享):
 * 流式更新只改末尾 entry,历史条目不重渲染。
 */
export const EntryView = memo(function EntryView({ entry }: { entry: ThreadEntry }) {
  const groupedChunks = useMemo(
    () => (entry.kind === "assistant_message" ? groupChunks(entry.chunks) : []),
    [entry],
  );

  switch (entry.kind) {
    case "user_message":
      return (
        <div className="flex justify-end">
          <Card
            className="max-w-[80%] gap-0 px-3 py-1.5 text-sm shadow-none bg-[var(--accent)]/15 border-[color:var(--accent)]/25"
          >
            <CardContent className="px-0 space-y-2">
              {entry.images && entry.images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {entry.images.map((img, i) => (
                    <img
                      key={i}
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt=""
                      className="max-h-48 max-w-full rounded-[var(--radius-sm)] object-contain"
                    />
                  ))}
                </div>
              )}
              {entry.text ? <p className="whitespace-pre-wrap">{entry.text}</p> : null}
            </CardContent>
          </Card>
        </div>
      );
    case "assistant_message":
      return (
        <div className="flex flex-col gap-1.5 max-w-[96%]">
          {groupedChunks.map((g, i) =>
            g.type === "thought" ? (
              <ThinkingBlock key={i} text={g.text} />
            ) : (
              <Card key={i} className="gap-0 px-3 py-1.5 text-sm shadow-none bg-[var(--glass-2-surface)] border-[color:var(--border-subtle)]">
                <CardContent className="px-0">
                  <div className="[&_pre]:overflow-x-auto [&_code]:text-[0.85em] [&_p]:my-1">
                    <ReactMarkdown>{g.text}</ReactMarkdown>
                  </div>
                </CardContent>
              </Card>
            ),
          )}
        </div>
      );
    case "tool_call":
      return (
        <div className="max-w-[96%]">
          <ToolCallCard entry={entry} />
        </div>
      );
    case "completed_plan":
      return (
        <div className="max-w-[96%] rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-2-surface)] px-2.5 py-1.5">
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] mb-1">
            <ListChecks size={14} />
            <span>Completed Plan — {entry.entries.length} steps</span>
          </div>
          <ul className="text-xs space-y-1 text-[var(--text-primary)]">
            {entry.entries.map((e, i) => (
              <li key={i} className="opacity-70">
                {e.content}
              </li>
            ))}
          </ul>
        </div>
      );
  }
});
```

注意:`max-w-[80%]` 是工作区既有未提交改动的值,保持它。

- [ ] **Step 6: 改造 ThreadView.tsx**

Modify `src/features/agent/thread/ThreadView.tsx`:

1. 删除文件底部 `function EntryView(...)` 整个定义(约 139-206 行)和 `function groupChunks(...)`(约 208-216 行);
2. 删除不再使用的 import:`react-markdown`、`Card/CardContent`、`ThinkingBlock`、`ToolCallCard`(保留 `ToolCallGroup`)、`AssistantChunk` 类型;
3. 新增 import:`import { EntryView } from "./EntryView";`
4. `renderItems.map` 中 `<EntryView key={item.entry.id} entry={item.entry} />` 调用不变。

改后 ThreadView 顶部 import 应为:

```tsx
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Loader2, ListChecks } from "lucide-react";
import { useAgentStore } from "../../../stores/agent.store";
import { useProjectStore } from "../../../stores/project.store";
import { selectProjectActiveTabId, useConversationStore } from "../../../stores/conversation.store";
import { EntryView } from "./EntryView";
import { ToolCallGroup } from "./ToolCallCard";
import { groupThreadEntries } from "./groupThreadEntries";
import type { ThreadEntry } from "./types";
```

注意:`ListChecks` 若 ThreadView 内已无引用则一并删除(`completed_plan` 已随 EntryView 搬走);`AgentLoadingIndicator` 仍用到 `Loader2`。以 `pnpm exec tsc -b` 的 unused 报错为准。

- [ ] **Step 7: 类型检查 + 全量测试**

Run: `pnpm exec tsc -b && pnpm exec vitest run`
Expected: 全绿

- [ ] **Step 8: Commit**

```bash
git add src/features/agent/thread/groupChunks.ts src/features/agent/thread/groupChunks.test.ts src/features/agent/thread/EntryView.tsx src/features/agent/thread/ThreadView.tsx
git commit -m "refactor(ui): EntryView 拆出并 memo 化,groupChunks 提取记忆化

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 订阅收窄 + 分组记忆化 + 串扰/结构共享测试

**Files:**
- Modify: `src/features/agent/thread/ThreadView.tsx`(selector 与 useMemo)
- Create: `src/features/agent/thread/threadTestUtils.tsx`(本任务只用其中的 `setupThreadStores`;虚拟列表 mock 在 Task 5 补)
- Create: `src/features/agent/thread/ThreadView.crosstalk.test.tsx`
- Modify: `src/stores/agent.store.test.ts`(追加结构共享测试)

**Interfaces:**
- Consumes: Task 2 的 `EntryView`
- Produces: `threadTestUtils.tsx` 的 `setupThreadStores(activeTabId, entriesByConversation)`(Task 5 会继续扩充该文件)

- [ ] **Step 1: 在 agent.store.test.ts 末尾追加结构共享前提测试**

Modify `src/stores/agent.store.test.ts`,在文件末尾追加(复用文件顶部已有的 bridge mock):

```ts
describe("entriesByConversation 结构共享", () => {
  it("更新会话 A 不改变会话 B 的数组引用", () => {
    useAgentStore.setState((s) => {
      s.entriesByConversation = {
        A: [{ id: "a1", kind: "user_message", text: "hi", timestamp: 1 }],
        B: [{ id: "b1", kind: "user_message", text: "yo", timestamp: 2 }],
      };
    });
    const beforeB = useAgentStore.getState().entriesByConversation["B"];
    const beforeA = useAgentStore.getState().entriesByConversation["A"];

    useAgentStore.setState((s) => {
      s.entriesByConversation["A"]?.push({
        id: "a2",
        kind: "user_message",
        text: "more",
        timestamp: 3,
      });
    });

    const after = useAgentStore.getState().entriesByConversation;
    expect(after["B"]).toBe(beforeB); // B 引用不变 → 收窄 selector 不会重渲染
    expect(after["A"]).not.toBe(beforeA);
  });
});
```

- [ ] **Step 2: 运行确认通过(锁定前提)**

Run: `pnpm exec vitest run src/stores/agent.store.test.ts`
Expected: PASS(该测试验证 immer 现状,应直接通过;它锁定订阅收窄的地基)

- [ ] **Step 3: 创建 threadTestUtils.tsx(store 播种部分)**

Create `src/features/agent/thread/threadTestUtils.tsx`:

```tsx
/**
 * 线程视图的测试/开发基建。仅被 .test.tsx 与 DEV-only 动态 import 引用,
 * 不进生产 bundle。
 */
import { useAgentStore } from "../../../stores/agent.store";
import { useProjectStore } from "../../../stores/project.store";
import { useConversationStore } from "../../../stores/conversation.store";
import type { ThreadEntry } from "./types";

/** 把 ThreadView 所需的三个 store 摆成"项目 p1、指定活动 tab、给定 entries"的状态。 */
export function setupThreadStores(
  activeTabId: string,
  entriesByConversation: Record<string, ThreadEntry[]>,
) {
  useProjectStore.setState({ activeProjectId: "p1" });
  useConversationStore.setState((s) => {
    s.tabsByProject = { p1: Object.keys(entriesByConversation) };
    s.activeTabByProject = { p1: activeTabId };
  });
  useAgentStore.setState((s) => {
    s.entriesByConversation = entriesByConversation;
  });
}
```

- [ ] **Step 4: 写串扰失败测试**

Create `src/features/agent/thread/ThreadView.crosstalk.test.tsx`:

```tsx
/**
 * @vitest-environment jsdom
 */
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("../../../bridge/tauri", () => ({
  // agent.store 所需
  agentCreateSession: vi.fn(),
  agentSendPrompt: vi.fn(),
  agentCancel: vi.fn(),
  agentRespondPermission: vi.fn(),
  agentCloseSession: vi.fn(),
  agentListServers: vi.fn().mockResolvedValue([]),
  agentListAllServers: vi.fn().mockResolvedValue([]),
  agentRefreshRegistry: vi.fn(),
  agentCustomUpsert: vi.fn(),
  agentCustomDelete: vi.fn(),
  agentSetSessionMode: vi.fn(),
  agentSetSessionModel: vi.fn(),
  agentSetSessionConfigOption: vi.fn(),
  conversationReplaceThreadEntries: vi.fn(),
  onAgentNotification: () => Promise.resolve(() => {}),
  onAgentPermissionRequest: () => Promise.resolve(() => {}),
  onAgentSessionTerminated: () => Promise.resolve(() => {}),
  // conversation.store 所需
  conversationCreate: vi.fn(),
  conversationList: vi.fn().mockResolvedValue([]),
  conversationGetMessages: vi.fn().mockResolvedValue([]),
  conversationUpdateTitle: vi.fn(),
  conversationAppendMessage: vi.fn(),
  // project.store 所需
  projectOpen: vi.fn(),
  projectList: vi.fn().mockResolvedValue([]),
}));

import { ThreadView } from "./ThreadView";
import { setupThreadStores } from "./threadTestUtils";
import { useAgentStore } from "../../../stores/agent.store";
import type { ThreadEntry } from "./types";

beforeEach(() => {
  setupThreadStores("A", {
    A: [{ id: "a1", kind: "user_message", text: "hi", timestamp: 1 }],
    B: [{ id: "b1", kind: "user_message", text: "yo", timestamp: 2 }],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThreadView 订阅收窄", () => {
  it("后台会话的流式更新不触发前台 ThreadView 重渲染", async () => {
    const onRender = vi.fn();
    render(
      <Profiler id="thread" onRender={onRender}>
        <ThreadView />
      </Profiler>,
    );
    onRender.mockClear();

    act(() => {
      useAgentStore.setState((s) => {
        s.entriesByConversation["B"] = [
          ...(s.entriesByConversation["B"] ?? []),
          { id: "b2", kind: "user_message", text: "后台新增", timestamp: 3 } as ThreadEntry,
        ];
      });
    });

    expect(onRender).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `pnpm exec vitest run src/features/agent/thread/ThreadView.crosstalk.test.tsx`
Expected: FAIL —— 当前 ThreadView 订阅整张 `entriesByConversation` map,B 变化会触发重渲染,`onRender` 被调用。

若报缺少 mock 导出,按报错把该名字加进 `vi.mock` 工厂(值用 `vi.fn()`)。

- [ ] **Step 6: 收窄 ThreadView 订阅 + 分组记忆化**

Modify `src/features/agent/thread/ThreadView.tsx`,替换组件开头(约 42-50 行)的选择与计算:

```tsx
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

/** 稳定空数组,避免 useSyncExternalStore 因内联 [] 每次新引用而抖动。 */
const EMPTY_ENTRIES: ThreadEntry[] = [];
```

组件体内,把:

```tsx
const entriesByConversation = useAgentStore((s) => s.entriesByConversation);
const sessions = useAgentStore((s) => s.sessions);
const entries = activeTabId ? (entriesByConversation[activeTabId] ?? []) : [];
const sessionStatus = activeTabId ? sessions[activeTabId]?.status : undefined;
const showLoading = shouldShowAgentLoading(sessionStatus, entries);
const renderItems = groupThreadEntries(entries);
```

替换为:

```tsx
const entries = useAgentStore((s) =>
  activeTabId ? (s.entriesByConversation[activeTabId] ?? EMPTY_ENTRIES) : EMPTY_ENTRIES,
);
const sessionStatus = useAgentStore((s) =>
  activeTabId ? s.sessions[activeTabId]?.status : undefined,
);
const showLoading = shouldShowAgentLoading(sessionStatus, entries);
const renderItems = useMemo(() => groupThreadEntries(entries), [entries]);
```

- [ ] **Step 7: 运行确认通过**

Run: `pnpm exec vitest run src/features/agent/thread/ThreadView.crosstalk.test.tsx src/stores/agent.store.test.ts`
Expected: 全绿

- [ ] **Step 8: 全量检查**

Run: `pnpm exec tsc -b && pnpm exec vitest run`
Expected: 全绿

- [ ] **Step 9: Commit**

```bash
git add src/features/agent/thread/ThreadView.tsx src/features/agent/thread/threadTestUtils.tsx src/features/agent/thread/ThreadView.crosstalk.test.tsx src/stores/agent.store.test.ts
git commit -m "perf(ui): ThreadView 订阅收窄至当前会话,分组记忆化

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 工具卡展开态外提 + tool_group key 稳定化

**Files:**
- Create: `src/features/agent/thread/toolCardExpansion.ts`
- Create: `src/features/agent/thread/toolCardExpansion.test.ts`
- Modify: `src/features/agent/thread/ToolCallCard.tsx`
- Modify: `src/features/agent/thread/groupThreadEntries.ts`
- Modify: `src/features/agent/thread/groupThreadEntries.test.ts`

**Interfaces:**
- Produces:
  - `useToolCardExpansionStore`:zustand store,`{ overrides: Record<string, boolean>, setExpanded(toolCallId: string, open: boolean): void }`
  - `groupThreadEntries` 返回的 `tool_group.key` 改为**首个 entry id**(消费方:ThreadView 的 rowKey、Task 5/6)

- [ ] **Step 1: 写展开态 store 失败测试**

Create `src/features/agent/thread/toolCardExpansion.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useToolCardExpansionStore } from "./toolCardExpansion";

beforeEach(() => {
  useToolCardExpansionStore.setState({ overrides: {} });
});

describe("useToolCardExpansionStore", () => {
  it("setExpanded 写入覆盖值", () => {
    useToolCardExpansionStore.getState().setExpanded("tc1", false);
    expect(useToolCardExpansionStore.getState().overrides["tc1"]).toBe(false);
    useToolCardExpansionStore.getState().setExpanded("tc1", true);
    expect(useToolCardExpansionStore.getState().overrides["tc1"]).toBe(true);
  });

  it("未显式设置的 id 返回 undefined(回退默认规则)", () => {
    expect(useToolCardExpansionStore.getState().overrides["nope"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/features/agent/thread/toolCardExpansion.test.ts`
Expected: FAIL,`Cannot find module './toolCardExpansion'`

- [ ] **Step 3: 实现 toolCardExpansion.ts**

Create `src/features/agent/thread/toolCardExpansion.ts`:

```ts
import { create } from "zustand";

interface ToolCardExpansionState {
  /** key = toolCallId(流式 upsert 的稳定键),value = 用户显式设置的展开态。 */
  overrides: Record<string, boolean>;
  setExpanded: (toolCallId: string, open: boolean) => void;
}

/**
 * 工具卡展开状态外提:虚拟化会卸载/重挂离屏行,组件内 useState 会丢。
 * 未显式设置(undefined)时由组件回退默认规则(edit/waiting 默认展开)。
 * 不 persist:展开态是会话级临时 UI 状态。
 */
export const useToolCardExpansionStore = create<ToolCardExpansionState>()((set) => ({
  overrides: {},
  setExpanded: (toolCallId, open) =>
    set((s) => ({ overrides: { ...s.overrides, [toolCallId]: open } })),
}));
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/features/agent/thread/toolCardExpansion.test.ts`
Expected: PASS(2 个)

- [ ] **Step 5: 写展开态跨重挂失败测试**

Create `src/features/agent/thread/ToolCallCard.expansion.test.tsx`:

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToolCallCard } from "./ToolCallCard";
import { useToolCardExpansionStore } from "./toolCardExpansion";
import type { ToolCallEntry } from "./types";

// 本测试只用文本内容卡,不触发 CodeMirror;mock 掉保持轻量。
vi.mock("./ThreadDiffBlock", () => ({ ThreadDiffBlock: () => <div data-testid="diff" /> }));
vi.mock("../../../stores/agent.store", () => ({
  useAgentStore: (sel: (s: { respondPermission: () => void }) => unknown) =>
    sel({ respondPermission: () => {} }),
}));

const entry: ToolCallEntry = {
  id: "t1",
  toolCallId: "tc1",
  kind: "tool_call",
  toolKind: "read",
  title: "Read File",
  status: "completed",
  content: [{ type: "text", text: "结果" }],
  timestamp: 1,
};

beforeEach(() => useToolCardExpansionStore.setState({ overrides: {} }));
afterEach(() => cleanup());

describe("ToolCallCard 展开态外提", () => {
  it("手动展开的状态在卸载重挂后还原", () => {
    const { unmount } = render(<ToolCallCard entry={entry} />);
    expect(screen.queryByText("结果")).toBeNull(); // 非 edit 默认收起

    fireEvent.click(screen.getByText("Read File"));
    expect(screen.getByText("结果")).toBeTruthy();
    unmount();

    render(<ToolCallCard entry={entry} />);
    expect(screen.getByText("结果")).toBeTruthy(); // 重挂后仍展开
  });
});
```

- [ ] **Step 6: 运行确认失败**

Run: `pnpm exec vitest run src/features/agent/thread/ToolCallCard.expansion.test.tsx`
Expected: FAIL —— 现实现 useState 随卸载重置,重挂后回到收起态,最后的断言失败

- [ ] **Step 7: 改造 ToolCallCard.tsx 使用外提状态**

Modify `src/features/agent/thread/ToolCallCard.tsx`:

`ToolCallCard` 内,把:

```tsx
  const [open, setOpen] = useState(
    defaultOpen ?? (isEdit || waiting),
  );
```

替换为:

```tsx
  const override = useToolCardExpansionStore((s) => s.overrides[entry.toolCallId]);
  const setExpanded = useToolCardExpansionStore((s) => s.setExpanded);
  const open = override ?? (defaultOpen ?? (isEdit || waiting));
```

头部 import 增加 `import { useToolCardExpansionStore } from "./toolCardExpansion";`,删除 `useState`(若 `useEffect` 仍在用则保留)。

强制展开 effect 改为写外提 store:

```tsx
  // Permission prompts must surface even if the card started collapsed.
  useEffect(() => {
    if (waiting) setExpanded(entry.toolCallId, true);
  }, [waiting, entry.toolCallId, setExpanded]);
```

折叠头按钮 onClick 改为:

```tsx
        onClick={() => setExpanded(entry.toolCallId, !open)}
```

`ToolCallGroup` 同理外提,组展开键用 `group:${entries[0]?.id}`(与 Task 中 groupThreadEntries 新 key 规则呼应):

```tsx
export function ToolCallGroup({ entries }: { entries: ToolCallEntry[] }) {
  const groupKey = `group:${entries[0]?.id}`;
  const needsPermission = entries.some((e) => e.status === "waiting_for_confirmation");
  const override = useToolCardExpansionStore((s) => s.overrides[groupKey]);
  const setExpanded = useToolCardExpansionStore((s) => s.setExpanded);
  const open = override ?? needsPermission;

  useEffect(() => {
    if (needsPermission) setExpanded(groupKey, true);
  }, [needsPermission, groupKey, setExpanded]);

  const busy = entries.some(
    (e) =>
      e.status === "in_progress" ||
      e.status === "waiting_for_confirmation" ||
      e.status === "pending",
  );
```

并把组内 `onClick={() => setOpen((v) => !v)}` 改为 `onClick={() => setExpanded(groupKey, !open)}`。

- [ ] **Step 8: 写 tool_group key 稳定性失败测试**

Modify `src/features/agent/thread/groupThreadEntries.test.ts`,在 describe 内追加:

```ts
  it("tool_group key 在成员流式追加时保持不变", () => {
    const two: ThreadEntry[] = [
      tool({ id: "t1", toolKind: "search", title: "grep" }),
      tool({ id: "t2", toolKind: "read", title: "Read File" }),
    ];
    const three: ThreadEntry[] = [...two, tool({ id: "t3", toolKind: "read", title: "Read File" })];

    const items2 = groupThreadEntries(two);
    const items3 = groupThreadEntries(three);
    expect(items2[0]?.type).toBe("tool_group");
    expect(items3[0]?.type).toBe("tool_group");
    if (items2[0].type === "tool_group" && items3[0].type === "tool_group") {
      expect(items3[0].key).toBe(items2[0].key);
    }
  });
```

- [ ] **Step 9: 运行确认失败**

Run: `pnpm exec vitest run src/features/agent/thread/groupThreadEntries.test.ts`
Expected: FAIL —— 现 key 是全部 id join,`t1:t2:t3` ≠ `t1:t2`

- [ ] **Step 10: 修复 groupThreadEntries key**

Modify `src/features/agent/thread/groupThreadEntries.ts` 中 `flushTools`:

```ts
  const flushTools = () => {
    if (toolBuf.length === 0) return;
    items.push({
      type: "tool_group",
      entries: toolBuf,
      // 首个 id 作 key:成员流式追加时 key 不变,避免整组 remount 丢展开态。
      key: toolBuf[0].id,
    });
    toolBuf = [];
  };
```

- [ ] **Step 11: 运行确认通过 + 全量检查**

Run: `pnpm exec vitest run src/features/agent/thread/groupThreadEntries.test.ts src/features/agent/thread/toolCardExpansion.test.ts src/features/agent/thread/ToolCallCard.expansion.test.tsx && pnpm exec tsc -b && pnpm exec vitest run`
Expected: 全绿

- [ ] **Step 12: Commit**

```bash
git add src/features/agent/thread/toolCardExpansion.ts src/features/agent/thread/toolCardExpansion.test.ts src/features/agent/thread/ToolCallCard.tsx src/features/agent/thread/ToolCallCard.expansion.test.tsx src/features/agent/thread/groupThreadEntries.ts src/features/agent/thread/groupThreadEntries.test.ts
git commit -m "refactor(ui): 工具卡展开态外提,tool_group key 稳定化

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 虚拟列表测试基建 + 窗口化冒烟测试(红)

**Files:**
- Modify: `src/features/agent/thread/threadTestUtils.tsx`(扩充 jsdom 布局 mock)
- Create: `src/features/agent/thread/ThreadView.virtual.test.tsx`(本任务只加窗口化冒烟用例,红)

**Interfaces:**
- Consumes: Task 3 的 `setupThreadStores`
- Produces:
  - `installVirtualListMocks(opts?: { viewportHeight?: number; rowHeight?: number }): void` —— 全局安装 jsdom 布局 mock(ResizeObserver stub、getBoundingClientRect/offsetHeight/clientHeight/scrollHeight/scrollTop/scrollTo)
  - `getScroller(container: HTMLElement): HTMLElement` —— 取滚动容器(`.overflow-y-auto`)
  - `setMockScrollHeight(el: Element, h: number): void`

- [ ] **Step 1: 扩充 threadTestUtils.tsx**

Modify `src/features/agent/thread/threadTestUtils.tsx`,在文件顶部 import 区增加 `import { vi } from "vitest";`,并在 `setupThreadStores` 之后追加:

```tsx
/* ---------- jsdom 布局 mock:让 useVirtualizer 在无真实布局环境下工作 ---------- */

const mockHeights = new WeakMap<Element, number>();
const mockScrollHeights = new WeakMap<Element, number>();
const mockScrollTops = new WeakMap<Element, number>();

export function setMockScrollHeight(el: Element, h: number) {
  mockScrollHeights.set(el, h);
}

/** 取 ThreadView 的滚动容器。 */
export function getScroller(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".overflow-y-auto");
  if (!el) throw new Error("未找到 .overflow-y-auto 滚动容器");
  return el;
}

/**
 * 安装虚拟列表所需的布局 mock。规则:
 * - 带 data-index 的行元素 → rowHeight(默认 60)
 * - classList 含 overflow-y-auto 的滚动容器 → viewportHeight(默认 600)
 * - 显式 setMockScrollHeight 设置过的 → 该值
 * 若 @tanstack/virtual-core 版本的取数 API 与上述不符(用 scrollLeft/其他读法),
 * 调试方法:render 后打印 virtualizer.scrollRect / scrollOffset / range,
 * 看哪个读数为 0,再按 node_modules/@tanstack/virtual-core 源码调整本 mock。
 */
export function installVirtualListMocks(opts?: { viewportHeight?: number; rowHeight?: number }) {
  const viewportHeight = opts?.viewportHeight ?? 600;
  const rowHeight = opts?.rowHeight ?? 60;

  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    let h = mockHeights.get(this);
    if (h === undefined) {
      if (this instanceof HTMLElement && this.classList.contains("overflow-y-auto")) {
        h = viewportHeight;
      } else if (this.hasAttribute("data-index")) {
        h = rowHeight;
      } else {
        h = 0;
      }
    }
    return {
      x: 0, y: 0, top: 0, left: 0, width: 800, height: h, right: 800, bottom: h,
      toJSON() { return this; },
    } as DOMRect;
  });

  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Math.round(this.getBoundingClientRect().height);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Math.round(this.getBoundingClientRect().height);
    },
  });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      return mockScrollHeights.get(this) ?? 0;
    },
  });
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return mockScrollTops.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      mockScrollTops.set(this, v);
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).scrollTo = function (
    this: Element,
    xOrOpts: number | ScrollToOptions,
    y?: number,
  ) {
    const top = typeof xOrOpts === "number" ? (y ?? 0) : (xOrOpts?.top ?? 0);
    mockScrollTops.set(this, top);
  };
}

/** 生成交替的 user/assistant 合成条目。 */
export function makeEntries(count: number): ThreadEntry[] {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? { id: `e${i}`, kind: "user_message", text: `消息 ${i}`, timestamp: i }
      : {
          id: `e${i}`,
          kind: "assistant_message",
          chunks: [{ type: "message", text: `回复 ${i}` }],
          timestamp: i,
        },
  ) as ThreadEntry[];
}
```

- [ ] **Step 2: 写窗口化冒烟失败测试**

Create `src/features/agent/thread/ThreadView.virtual.test.tsx`:

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("../../../bridge/tauri", () => ({
  agentCreateSession: vi.fn(),
  agentSendPrompt: vi.fn(),
  agentCancel: vi.fn(),
  agentRespondPermission: vi.fn(),
  agentCloseSession: vi.fn(),
  agentListServers: vi.fn().mockResolvedValue([]),
  agentListAllServers: vi.fn().mockResolvedValue([]),
  agentRefreshRegistry: vi.fn(),
  agentCustomUpsert: vi.fn(),
  agentCustomDelete: vi.fn(),
  agentSetSessionMode: vi.fn(),
  agentSetSessionModel: vi.fn(),
  agentSetSessionConfigOption: vi.fn(),
  conversationReplaceThreadEntries: vi.fn(),
  onAgentNotification: () => Promise.resolve(() => {}),
  onAgentPermissionRequest: () => Promise.resolve(() => {}),
  onAgentSessionTerminated: () => Promise.resolve(() => {}),
  conversationCreate: vi.fn(),
  conversationList: vi.fn().mockResolvedValue([]),
  conversationGetMessages: vi.fn().mockResolvedValue([]),
  conversationUpdateTitle: vi.fn(),
  conversationAppendMessage: vi.fn(),
  projectOpen: vi.fn(),
  projectList: vi.fn().mockResolvedValue([]),
}));

import { ThreadView } from "./ThreadView";
import {
  getScroller,
  installVirtualListMocks,
  makeEntries,
  setMockScrollHeight,
  setupThreadStores,
} from "./threadTestUtils";
import { useAgentStore } from "../../../stores/agent.store";

beforeEach(() => {
  installVirtualListMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ThreadView 虚拟化", () => {
  it("1000 条 entries 只渲染视口附近的行(DOM 行数 < 60)", () => {
    setupThreadStores("A", { A: makeEntries(1000) });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 1000 * 60);

    const rows = container.querySelectorAll("[data-index]");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60); // 视口 10 行 + overscan 5×2,远小于 1000
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm exec vitest run src/features/agent/thread/ThreadView.virtual.test.tsx`
Expected: FAIL —— 当前全量渲染,`rows.length` 为 1000(或:尚无 `[data-index]` 属性,断言 `> 0` 失败)。两种失败都说明未虚拟化。

- [ ] **Step 4: Commit(红测试 + 基建)**

```bash
git add src/features/agent/thread/threadTestUtils.tsx src/features/agent/thread/ThreadView.virtual.test.tsx
git commit -m "test(ui): 虚拟列表测试基建与窗口化冒烟测试(红)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 接入 useVirtualizer + 贴底状态机(转绿)

**Files:**
- Modify: `src/features/agent/thread/ThreadView.tsx`(JSX 骨架 + 滚动逻辑整体替换)
- Modify: `src/features/agent/thread/ThreadView.virtual.test.tsx`(追加跟随/取消跟随/切 tab 用例)

**Interfaces:**
- Consumes: Task 2 的 `EntryView`(memo)、Task 3 的 `renderItems`(useMemo)、Task 4 的稳定 group key
- Produces: ThreadView 完成虚拟化;行为契约:跟随态下新内容贴底、上滚 >80px 取消跟随、切 tab 重置跟随并到底

- [ ] **Step 1: 先写行为测试(红)**

Modify `src/features/agent/thread/ThreadView.virtual.test.tsx`,在 describe 内追加三个用例:

```tsx
  it("跟随态:追加条目后自动滚动到底部", async () => {
    setupThreadStores("A", { A: makeEntries(100) });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 100 * 60);
    await act(async () => {}); // 让挂载后的测量/滚动 settle

    act(() => {
      useAgentStore.setState((s) => {
        s.entriesByConversation["A"] = [
          ...(s.entriesByConversation["A"] ?? []),
          { id: "new1", kind: "user_message", text: "新消息", timestamp: 999 },
        ];
      });
    });
    await act(async () => {});

    // 101 行 × 60px − 视口 600px ≈ 5460;断言已滚到靠近底部
    expect(scroller.scrollTop).toBeGreaterThan(4000);
  });

  it("上滚超过 80px 后取消跟随,新条目不再拉回底部", async () => {
    setupThreadStores("A", { A: makeEntries(100) });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 100 * 60);
    await act(async () => {});

    scroller.scrollTop = 0; // 手动到顶
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    act(() => {
      useAgentStore.setState((s) => {
        s.entriesByConversation["A"] = [
          ...(s.entriesByConversation["A"] ?? []),
          { id: "new1", kind: "user_message", text: "新消息", timestamp: 999 },
        ];
      });
    });
    await act(async () => {});

    expect(scroller.scrollTop).toBe(0);
  });

  it("切换会话后恢复跟随并滚动到新会话底部", async () => {
    setupThreadStores("A", { A: makeEntries(100), B: makeEntries(50) });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 100 * 60);
    await act(async () => {});

    scroller.scrollTop = 0;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    act(() => {
      useConversationStore.setState((s) => {
        s.activeTabByProject = { p1: "B" };
      });
    });
    await act(async () => {});

    expect(scroller.scrollTop).toBeGreaterThan(0); // B:50×60−600=2400
  });
```

并在文件 import 中补充 `useConversationStore`:

```tsx
import { useConversationStore } from "../../../stores/conversation.store";
```

- [ ] **Step 2: 运行确认新用例失败**

Run: `pnpm exec vitest run src/features/agent/thread/ThreadView.virtual.test.tsx`
Expected: 新增 3 个用例 FAIL(旧全量实现下 scrollTop 恒为 0 / 行为不符)

- [ ] **Step 3: 重写 ThreadView 的滚动与渲染**

Modify `src/features/agent/thread/ThreadView.tsx`。

头部 import 调整为:

```tsx
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import { useAgentStore } from "../../../stores/agent.store";
import { useProjectStore } from "../../../stores/project.store";
import { selectProjectActiveTabId, useConversationStore } from "../../../stores/conversation.store";
import { EntryView } from "./EntryView";
import { ToolCallGroup } from "./ToolCallCard";
import { groupThreadEntries, type ThreadRenderItem } from "./groupThreadEntries";
import { isEditTool } from "./toolCallUtils";
import type { ThreadEntry } from "./types";

const EMPTY_ENTRIES: ThreadEntry[] = [];

/** 距底部小于此阈值视为「仍在底部」,恢复自动跟随。 */
const NEAR_BOTTOM_PX = 80;

/** 行高估值:只影响滚动条精度,measureElement 实测持续校正。 */
function estimateRowHeight(item: ThreadRenderItem | undefined): number {
  if (!item) return 40; // 加载指示器行
  if (item.type === "tool_group") return 40;
  const e = item.entry;
  if (e.kind === "tool_call") return isEditTool(e) ? 420 : 48;
  return 96;
}

function rowKey(item: ThreadRenderItem | undefined): string {
  if (!item) return "agent-loading";
  return item.type === "tool_group" ? `g:${item.key}` : item.entry.id;
}
```

组件体内,保留:activeProjectId / activeTabId / entries / sessionStatus / showLoading / renderItems(Task 3 版本)。删除旧的 `contentRef`、`scrollToBottom`、`onScroll` 旧实现、三个旧 effect、旧 JSX。替换为:

```tsx
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastUserMsgIdRef = useRef<string | null>(null);

  const count = renderItems.length + (showLoading ? 1 : 0);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (i) => estimateRowHeight(renderItems[i]),
    overscan: 5,
    // 显式用 getBoundingClientRect:兼容小数高度,且是测试 mock 的确定接缝。
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance <= NEAR_BOTTOM_PX;
  }, []);

  // 跟随态下:条目数/总高度变化(含流式撑高末尾条目)→ 贴底。
  useLayoutEffect(() => {
    if (stickToBottomRef.current && count > 0) {
      virtualizer.scrollToIndex(count - 1, { align: "end" });
    }
  }, [count, totalSize, virtualizer]);

  // 用户发送新消息:强制恢复跟随(实际滚动由上方 effect 在 count 变化时执行)。
  useLayoutEffect(() => {
    const userId = lastUserMessageId(entries);
    if (userId && userId !== lastUserMsgIdRef.current) {
      lastUserMsgIdRef.current = userId;
      stickToBottomRef.current = true;
    }
  }, [entries]);

  // 切换对话:恢复跟随并直接滚到底(两个会话 count 可能相同,不能只靠 count 依赖)。
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    lastUserMsgIdRef.current = lastUserMessageId(entries);
    if (count > 0) virtualizer.scrollToIndex(count - 1, { align: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className="flex-1 min-h-0 overflow-y-auto px-4 py-3"
    >
      {entries.length === 0 ? (
        <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
          Start a conversation
        </div>
      ) : (
        <div style={{ height: totalSize, position: "relative" }}>
          {virtualItems.map((vi) => {
            const item = renderItems[vi.index];
            return (
              <div
                key={rowKey(item)}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className="pb-3"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {item ? (
                  item.type === "tool_group" ? (
                    <ToolCallGroup entries={item.entries} />
                  ) : (
                    <EntryView entry={item.entry} />
                  )
                ) : (
                  <AgentLoadingIndicator />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
```

保留 `lastUserMessageId`、`shouldShowAgentLoading`、`AgentLoadingIndicator` 三个辅助定义(位置不动)。删除未再使用的 import(`useEffect` 若无引用)。

- [ ] **Step 4: 运行虚拟列表测试**

Run: `pnpm exec vitest run src/features/agent/thread/ThreadView.virtual.test.tsx`
Expected: 4 个用例全 PASS。

若窗口化用例返回 0 行:按 threadTestUtils 中的调试说明,打印 `virtualizer.scrollRect` 定位 mock 缺口(不同 virtual-core 小版本读取 rect 的 API 可能是 clientHeight 而非 gBCR,补齐对应 mock)。

- [ ] **Step 5: 全量检查**

Run: `pnpm exec tsc -b && pnpm exec vitest run && pnpm lint`
Expected: 全绿,无新 lint 告警

- [ ] **Step 6: 手动验证**

Run: `pnpm dev`。回归项:打开会话→默认在底部;agent 流式输出时视图跟随;手动上滚超过一屏后流式不拉回;滚回底部后恢复跟随;切换会话标签后在新会话底部;权限确认卡出现时自动展开可点击。

- [ ] **Step 7: Commit**

```bash
git add src/features/agent/thread/ThreadView.tsx src/features/agent/thread/ThreadView.virtual.test.tsx
git commit -m "feat(ui): ThreadView 接入 react-virtual 虚拟滚动与贴底跟随

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: ThreadDiffBlock 延迟挂载 CodeMirror

**Files:**
- Modify: `src/features/agent/thread/ThreadDiffBlock.tsx`
- Modify: `src/features/agent/thread/ThreadDiffBlock.test.tsx`

**Interfaces:**
- Consumes: 无新依赖
- Produces: ThreadDiffBlock 挂载后 ~120ms 内渲染占位(min-height 96px),之后才挂载 `DiffView`(CodeMirror);卸载早于计时器则永不挂载

- [ ] **Step 1: 更新既有测试并写新用例(先红后绿)**

Modify `src/features/agent/thread/ThreadDiffBlock.test.tsx` 为:

```tsx
/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadDiffBlock } from "./ThreadDiffBlock";

vi.mock("../../../stores/settings.store", () => ({
  useSettingsStore: (sel: (s: { theme: "light" | "dark" }) => unknown) =>
    sel({ theme: "light" }),
}));

beforeEach(() => {
  // 只 fake 计时器,保留 rAF(CodeMirror 需要)。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flushMountDelay() {
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
}

describe("ThreadDiffBlock", () => {
  it("延迟后渲染 CodeMirror merge 视图与路径头", async () => {
    const { container, getByText } = render(
      <ThreadDiffBlock path="src/foo.ts" oldText={"const a = 1;\n"} newText={"const a = 2;\n"} />,
    );
    expect(getByText("src/foo.ts")).toBeTruthy();
    expect(container.querySelector(".cm-editor")).toBeNull(); // 占位阶段

    await flushMountDelay();
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });

  it("无 path 时不渲染头部(延迟后编辑器照常出现)", async () => {
    const { container, queryByText } = render(<ThreadDiffBlock oldText="a" newText="b" />);
    expect(queryByText("src/foo.ts")).toBeNull();
    await flushMountDelay();
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });

  it("延迟期内卸载则不挂载编辑器且不报错", () => {
    const { container, unmount } = render(<ThreadDiffBlock oldText="a" newText="b" />);
    expect(container.querySelector(".cm-editor")).toBeNull();
    unmount();
    expect(() => act(() => { vi.advanceTimersByTime(150); })).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/features/agent/thread/ThreadDiffBlock.test.tsx`
Expected: FAIL —— 现实现同步挂载,第一个用例的"占位阶段 .cm-editor 为 null"断言失败

- [ ] **Step 3: 实现延迟挂载**

Modify `src/features/agent/thread/ThreadDiffBlock.tsx`。import 增加 `useEffect, useState`:

```tsx
import { useEffect, useMemo, useState } from "react";
```

组件内,在现有 hooks 之后、return 之前插入:

```tsx
  // 延迟挂载:进入可视区后先占位,停留 ~120ms 再建 CodeMirror。
  // 快速滚过的行在计时器触发前已被虚拟化卸载,昂贵的 merge 计算不会发生。
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 120);
    return () => clearTimeout(t);
  }, []);
```

return 体改为(路径头保留,占位带 min-height 减少跳动):

```tsx
  return (
    <div className="rounded bg-[var(--glass-2-surface)] overflow-hidden">
      {path ? (
        <div className="px-2 py-1 text-[10px] font-mono text-[var(--text-tertiary)] truncate border-b border-[color:var(--border-subtle)]">
          {path}
        </div>
      ) : null}
      {ready ? (
        <DiffView
          payload={payload}
          theme={theme}
          extensions={extensions}
          height="auto"
          maxHeight="320px"
        />
      ) : (
        <div style={{ minHeight: 96 }} aria-hidden="true" />
      )}
    </div>
  );
```

- [ ] **Step 4: 运行确认通过 + 全量检查**

Run: `pnpm exec vitest run src/features/agent/thread/ThreadDiffBlock.test.tsx && pnpm exec tsc -b && pnpm exec vitest run`
Expected: 全绿

- [ ] **Step 5: 手动验证**

Run: `pnpm dev`。打开含多张 edit 卡的会话:卡片展开后 diff 短暂占位后出现(120ms,基本无感);慢慢滚动到展开的 edit 卡,diff 正常渲染;快速掠过大片 edit 卡无卡顿。

- [ ] **Step 6: Commit**

```bash
git add src/features/agent/thread/ThreadDiffBlock.tsx src/features/agent/thread/ThreadDiffBlock.test.tsx
git commit -m "perf(ui): ThreadDiffBlock 延迟挂载 CodeMirror

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: loadMessages 分页修复

**Files:**
- Modify: `src/stores/conversation.store.ts`(`loadMessages` 约 261-280 行)
- Modify: `src/stores/conversation.store.test.ts`(追加分页用例)

**Interfaces:**
- Consumes: `conversationGetMessages(conversationId, limit = 50, offset = 0): Promise<Message[]>`(bridge 签名不变)
- Produces: `loadMessages` 以 50 为页循环取完全部历史;`messagesByConversation[id]` 为全量

- [ ] **Step 1: 写分页失败测试**

Modify `src/stores/conversation.store.test.ts`,在 describe 内追加(该文件已在顶部 mock `conversationGetMessages`):

```ts
  it("loadMessages 分页取完全部历史(修复 50 条截断)", async () => {
    const mk = (i: number) =>
      ({ id: `m${i}`, conversationId: "c1", role: "user", content: `msg ${i}`, createdAt: i }) as never;
    conversationGetMessages.mockImplementation(async (_id: string, _limit: number, offset: number) => {
      if (offset < 100) return Array.from({ length: 50 }, (_, i) => mk(offset + i));
      return Array.from({ length: 20 }, (_, i) => mk(offset + i));
    });

    await useConversationStore.getState().loadMessages("c1");

    expect(conversationGetMessages).toHaveBeenCalledTimes(3);
    expect(conversationGetMessages.mock.calls.map((c) => c[2])).toEqual([0, 50, 100]);
    expect(useConversationStore.getState().messagesByConversation["c1"]).toHaveLength(120);
  });
```

注:`mk` 用 `as never` 绕过 Message 完整字段的类型噪音;若 tsc 对该文件的严格度不接受,改为 `as unknown as Message` 并 import `type { Message }` from `../bridge/tauri`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/stores/conversation.store.test.ts`
Expected: FAIL —— 现实现只调一次,`messagesByConversation` 长度 50

- [ ] **Step 3: 实现分页循环**

Modify `src/stores/conversation.store.ts`。在 store 定义外的模块顶部附近(紧邻其他常量)增加:

```ts
const MESSAGE_PAGE_SIZE = 50;
```

把 `loadMessages` 实现替换为:

```ts
      loadMessages: async (conversationId: string) => {
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          // 分页取完全部历史:旧实现只取首页 50 条,长会话旧消息静默丢失。
          const all: Message[] = [];
          let offset = 0;
          for (;;) {
            const page = await conversationGetMessages(conversationId, MESSAGE_PAGE_SIZE, offset);
            all.push(...page);
            if (page.length < MESSAGE_PAGE_SIZE) break;
            offset += MESSAGE_PAGE_SIZE;
          }
          set((s) => {
            s.messagesByConversation[conversationId] = all;
          });
        } catch (err) {
          set((s) => {
            s.error = errorMessage(err);
          });
        } finally {
          set((s) => {
            s.loading = false;
          });
        }
      },
```

确认文件顶部已从 `../bridge/tauri` import `type Message`(既有 import 块已含)。

- [ ] **Step 4: 运行确认通过 + 全量检查**

Run: `pnpm exec vitest run src/stores/conversation.store.test.ts src/features/projects/restoreProjectConversationTabs.test.ts && pnpm exec tsc -b && pnpm exec vitest run`
Expected: 全绿(回退路径消费方 restoreProjectConversationTabs 行为兼容)

- [ ] **Step 5: Commit**

```bash
git add src/stores/conversation.store.ts src/stores/conversation.store.test.ts
git commit -m "fix(ui): loadMessages 分页取完全部历史消息

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: 种子数据 + 性能验证 + 回归清单

**Files:**
- Modify: `src/features/agent/thread/threadTestUtils.tsx`(追加 `seedSyntheticThread`)
- Modify: `src/App.tsx`(临时 DEV 入口,Step 5 删除)

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 性能验收证据;`seedSyntheticThread` 留存为测试夹具

验收标准(来自 spec):
- 线程容器 DOM 行数与消息总数解耦(2000 条时 < 60 行)
- 快速滚动无 > 50ms 长任务,主观流畅
- React Profiler:流式时每 chunk 仅重渲染末尾一行
- 同时挂载的 CodeMirror 实例数 ≤ 视口行 + overscan

- [ ] **Step 1: 追加种子夹具**

Modify `src/features/agent/thread/threadTestUtils.tsx`,追加:

```ts
/**
 * 性能验证种子:2000 条 entries、约 1/6 为展开态 edit 卡(含真实 diff 文本)。
 * 用于 pnpm dev 下手动压测;留存为测试夹具。
 */
export function seedSyntheticThread(conversationId: string, count = 2000) {
  const oldText = "const a = 1;\n".repeat(40);
  const newText = "const a = 2;\n".repeat(40);
  const entries: ThreadEntry[] = Array.from({ length: count }, (_, i) => {
    if (i % 6 === 3) {
      return {
        id: `e${i}`, kind: "tool_call", toolCallId: `tc${i}`,
        title: `Edit file_${i}.ts`, toolKind: "edit", status: "completed",
        timestamp: i,
        content: [{ type: "diff", path: `src/file_${i}.ts`, oldText, newText }],
      };
    }
    if (i % 2 === 0) {
      return { id: `e${i}`, kind: "user_message", text: `用户消息 ${i}`, timestamp: i };
    }
    return {
      id: `e${i}`, kind: "assistant_message",
      chunks: [{ type: "message", text: `助手回复 ${i}\n\n一些内容。`.repeat(3) }],
      timestamp: i,
    };
  }) as ThreadEntry[];
  useAgentStore.getState().hydrateEntries(conversationId, entries);
}
```

- [ ] **Step 2: 加临时 DEV 入口**

Modify `src/App.tsx`,在组件函数体末尾(return 之前)插入:

```tsx
  // TEMP(perf 验证用,验证完删除):控制台 __seedThread(n?) 向当前会话灌合成数据
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let disposed = false;
    void import("./features/agent/thread/threadTestUtils").then((m) => {
      if (disposed) return;
      (window as unknown as Record<string, unknown>).__seedThread = (n?: number) => {
        const pid = useProjectStore.getState().activeProjectId;
        const tab = pid
          ? useConversationStore.getState().activeTabByProject[pid]
          : null;
        if (!tab) return console.warn("先打开一个会话");
        m.seedSyntheticThread(tab, n ?? 2000);
        console.log("seeded", n ?? 2000, "entries →", tab);
      };
    });
    return () => {
      disposed = true;
      delete (window as unknown as Record<string, unknown>).__seedThread;
    };
  }, []);
```

按 App.tsx 既有 import 情况补 `useEffect`、`useProjectStore`、`useConversationStore` 的 import。

- [ ] **Step 3: 性能验证**

Run: `pnpm dev`,打开一个会话,浏览器控制台执行 `__seedThread()`。

1. **DOM 行数**:控制台执行 `document.querySelectorAll('.overflow-y-auto [data-index]').length` → 应 < 60(消息总数 2000);
2. **滚动**:DevTools Performance 录制,快速拖动滚动条往返 → 无 > 50ms 长任务,主观流畅;
3. **流式重渲染**:发起一次真实 agent 对话(或保留种子数据后发消息),React DevTools Profiler 录制流式过程 → 每个 chunk 仅末尾一行 commit;
4. **CM 实例数**:控制台执行 `document.querySelectorAll('.cm-editor').length` → ≤ 视口内可见 edit 卡数 + overscan,而非种子中的 ~333。

把四项结果简述写进本任务 commit message。任一项不达标的处理:DOM 行数不达标 → 检查 Task 6 窗口化;长任务 → 检查 Card blur(Task 1)是否生效、edit 卡延迟挂载(Task 7);流式多行 commit → 检查 memo 与订阅(Task 2/3)。

- [ ] **Step 4: 回归清单(手动过一遍)**

`pnpm dev` 下逐项确认:权限确认卡自动展开且按钮可点;ThinkingBlock 展开/收起与内部滚动;edit 卡 diff 内容正确(merge 视图);空会话显示 "Start a conversation";发送新消息强制贴底;顶部会话页签拖拽排序正常;工具组(非 edit 工具)折叠/展开正常且流式追加成员时展开态不重置。

- [ ] **Step 5: 删除临时入口**

Modify `src/App.tsx`:删除 Step 2 插入的整个 `useEffect` 块及其专门为此新增的 import(恢复 App.tsx 原状,以 `git diff src/App.tsx` 为空为准)。

- [ ] **Step 6: 最终全量检查**

Run: `pnpm exec tsc -b && pnpm exec vitest run && pnpm lint`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add src/features/agent/thread/threadTestUtils.tsx src/App.tsx
git commit -m "test(ui): 长会话性能种子夹具,验证虚拟渲染达标

验收:DOM 行数与消息总数解耦、滚动无长任务、流式仅末行 commit、
CM 实例数 ≤ 视口+overscan。(临时 DEV 入口已删除)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

(若 Step 5 后 App.tsx 与原状一致,`git add src/App.tsx` 不会产生变更,仅提交 threadTestUtils。)

---

## 收尾

全部任务完成后,对照 spec 的"后续候选"确认未越界:流式节流、会话内搜索、FileTree/SearchPanel 虚拟化均**不在本次范围**。
