# Project-Scoped Agent Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话页签按项目隔离并持久化；切项目不中断 Agent；项目列表与页签显示 running/waiting；关页签一律确认后再 removeSession。

**Architecture:** 将 `conversation.store` 的全局 `openTabs`/`activeTabId` 改为 `tabsByProject`/`activeTabByProject`（persist + v0→v1 migrate）；读写以 `projectId` 或当前 `activeProjectId` 为槽；UI 用 selector 派生当前项目页签。`agent.sessions` 不变，切项目禁止 removeSession。关闭页签走 Modal 确认。项目指示器用纯函数聚合 session 状态。

**Tech Stack:** React 19、Zustand + immer + persist、Vitest、`@glinui/ui` Modal/Button、现有 agent/project stores

**Spec:** `docs/superpowers/specs/2026-07-26-project-scoped-agent-tabs-design.md`

## Global Constraints

- 包管理：pnpm；测试：`pnpm test`（Vitest）
- 页签存储：`tabsByProject: Record<string, string[]>` + `activeTabByProject: Record<string, string | null>`
- 切项目 / 开项目：**禁止**因切换调用 `removeSession` / `cancel`
- 关页签：一律确认；确认后 `await removeSession(id)` 再 `closeTab(id)`
- 指示器：`running` → `var(--accent)` + `animate-pulse`；`waiting` → `var(--warning)` 静态；可并存
- Persist name 保持 `nex-conversations`；`version: 1`；提交信息用简体中文
- 非目标：关整个项目批量 kill、终端按项目隔离、托盘通知、改 ACP

## File Structure

| 文件 | 职责 |
|---|---|
| `src/features/agent/projectSessionIndicators.ts` | 聚合项目内 running/waiting |
| `src/features/agent/projectSessionIndicators.test.ts` | 指示器单测 |
| `src/stores/conversation.store.ts` | 按项目 tabs、persist migrate、API |
| `src/stores/conversation.store.test.ts` | store 行为 + 迁移单测 |
| `src/App.tsx` | 启动恢复当前项目 tabs + 应用 legacy 迁移 |
| `src/features/projects/ProjectSelector.tsx` | 切项目不杀 Agent；校验 tabs；状态点 |
| `src/features/layout/TopBar.tsx` | 当前项目 tabs；关页签确认 |
| `src/features/agent/CloseTabConfirmDialog.tsx` | 关闭确认 Modal |
| `src/features/agent/MessageList.tsx` / `ChatInput.tsx` | 读派生 `activeTabId` |

---

### Task 1: 项目会话状态聚合纯函数

**Files:**
- Create: `src/features/agent/projectSessionIndicators.ts`
- Create: `src/features/agent/projectSessionIndicators.test.ts`

**Interfaces:**
- Produces:
  - `export type SessionStatusLike = "idle" | "running" | "waiting"`
  - `export function projectSessionIndicators(conversationIds: string[], sessions: Record<string, { status: SessionStatusLike } | undefined>): { hasRunning: boolean; hasWaiting: boolean }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { projectSessionIndicators } from "./projectSessionIndicators";

describe("projectSessionIndicators", () => {
  it("returns false/false when no ids or all idle/missing", () => {
    expect(projectSessionIndicators([], {})).toEqual({ hasRunning: false, hasWaiting: false });
    expect(
      projectSessionIndicators(["a"], { a: { status: "idle" } }),
    ).toEqual({ hasRunning: false, hasWaiting: false });
    expect(projectSessionIndicators(["a"], {})).toEqual({ hasRunning: false, hasWaiting: false });
  });

  it("detects running and waiting independently and together", () => {
    expect(
      projectSessionIndicators(["a", "b"], {
        a: { status: "running" },
        b: { status: "idle" },
      }),
    ).toEqual({ hasRunning: true, hasWaiting: false });

    expect(
      projectSessionIndicators(["a", "b"], {
        a: { status: "waiting" },
        b: { status: "idle" },
      }),
    ).toEqual({ hasRunning: false, hasWaiting: true });

    expect(
      projectSessionIndicators(["a", "b"], {
        a: { status: "running" },
        b: { status: "waiting" },
      }),
    ).toEqual({ hasRunning: true, hasWaiting: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/features/agent/projectSessionIndicators.test.ts`

Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
export type SessionStatusLike = "idle" | "running" | "waiting";

export function projectSessionIndicators(
  conversationIds: string[],
  sessions: Record<string, { status: SessionStatusLike } | undefined>,
): { hasRunning: boolean; hasWaiting: boolean } {
  let hasRunning = false;
  let hasWaiting = false;
  for (const id of conversationIds) {
    const status = sessions[id]?.status;
    if (status === "running") hasRunning = true;
    if (status === "waiting") hasWaiting = true;
    if (hasRunning && hasWaiting) break;
  }
  return { hasRunning, hasWaiting };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- src/features/agent/projectSessionIndicators.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/agent/projectSessionIndicators.ts src/features/agent/projectSessionIndicators.test.ts
git commit -m "feat(agent): 添加项目会话 running/waiting 聚合函数"
```

---

### Task 2: conversation.store 按项目页签 + persist 迁移

**Files:**
- Modify: `src/stores/conversation.store.ts`
- Create: `src/stores/conversation.store.test.ts`
- Modify（为通过编译，本任务末尾一并改 selector 读取）:
  - `src/App.tsx`（仅改字段名读法，完整启动逻辑在 Task 3）
  - `src/features/layout/TopBar.tsx`
  - `src/features/agent/MessageList.tsx`
  - `src/features/agent/ChatInput.tsx`

**Interfaces:**
- Consumes: `useProjectStore.getState().activeProjectId`（仅 `switchTab` / `closeTab` 无显式 projectId 时）
- Produces:
  - State: `tabsByProject`, `activeTabByProject`, `legacyTabsMigration: { tabs: string[]; activeId: string | null } | null`
  - `createConversation(projectId, agentType)` → 写入该 `projectId` 的 tabs 并激活
  - `switchTab(id)` / `closeTab(id)` → 只改当前 `activeProjectId` 槽
  - `restoreTabs(projectId, candidateTabs, candidateActiveId, validIds)`
  - `clearLegacyTabsMigration()`
  - Persist `version: 1`；partialize: `tabsByProject`, `activeTabByProject`, `legacyTabsMigration`
  - Export helpers:
    - `selectProjectOpenTabs(s, projectId): string[]`
    - `selectProjectActiveTabId(s, projectId): string | null`

- [ ] **Step 1: 写失败测试**

`src/stores/conversation.store.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const conversationCreate = vi.fn();
const conversationList = vi.fn();
const conversationGetMessages = vi.fn();

vi.mock("../bridge/tauri", () => ({
  conversationCreate: (...args: unknown[]) => conversationCreate(...args),
  conversationList: (...args: unknown[]) => conversationList(...args),
  conversationGetMessages: (...args: unknown[]) => conversationGetMessages(...args),
}));

vi.mock("./project.store", () => ({
  useProjectStore: {
    getState: () => ({ activeProjectId: mockActiveProjectId }),
  },
}));

let mockActiveProjectId: string | null = "proj-a";

import {
  migrateConversationPersist,
  selectProjectActiveTabId,
  selectProjectOpenTabs,
  useConversationStore,
} from "./conversation.store";

describe("conversation.store project-scoped tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveProjectId = "proj-a";
    useConversationStore.setState({
      conversationsByProject: {},
      tabsByProject: {},
      activeTabByProject: {},
      messagesByConversation: {},
      legacyTabsMigration: null,
      loading: false,
      error: null,
    });
  });

  it("createConversation writes tabs for that project only", async () => {
    conversationCreate.mockResolvedValueOnce({
      id: "c1",
      project_id: "proj-a",
      title: "t",
      agent_type: "x",
      created_at: "",
      updated_at: "",
    });
    await useConversationStore.getState().createConversation("proj-a", "x");
    expect(selectProjectOpenTabs(useConversationStore.getState(), "proj-a")).toEqual(["c1"]);
    expect(selectProjectActiveTabId(useConversationStore.getState(), "proj-a")).toBe("c1");
    expect(selectProjectOpenTabs(useConversationStore.getState(), "proj-b")).toEqual([]);
  });

  it("switchTab and closeTab only touch active project slot", () => {
    useConversationStore.setState({
      tabsByProject: {
        "proj-a": ["a1", "a2"],
        "proj-b": ["b1"],
      },
      activeTabByProject: { "proj-a": "a1", "proj-b": "b1" },
    });
    mockActiveProjectId = "proj-a";
    useConversationStore.getState().switchTab("a2");
    expect(useConversationStore.getState().activeTabByProject["proj-a"]).toBe("a2");
    expect(useConversationStore.getState().activeTabByProject["proj-b"]).toBe("b1");

    useConversationStore.getState().closeTab("a2");
    expect(useConversationStore.getState().tabsByProject["proj-a"]).toEqual(["a1"]);
    expect(useConversationStore.getState().activeTabByProject["proj-a"]).toBe("a1");
    expect(useConversationStore.getState().tabsByProject["proj-b"]).toEqual(["b1"]);
  });

  it("restoreTabs validates ids for a specific project", () => {
    useConversationStore.getState().restoreTabs(
      "proj-a",
      ["gone", "keep"],
      "gone",
      new Set(["keep"]),
    );
    expect(useConversationStore.getState().tabsByProject["proj-a"]).toEqual(["keep"]);
    expect(useConversationStore.getState().activeTabByProject["proj-a"]).toBe("keep");
  });

  it("migrateConversationPersist v0 maps openTabs into legacyTabsMigration", () => {
    const next = migrateConversationPersist(
      { openTabs: ["x"], activeTabId: "x" },
      0,
    );
    expect(next.tabsByProject).toEqual({});
    expect(next.activeTabByProject).toEqual({});
    expect(next.legacyTabsMigration).toEqual({ tabs: ["x"], activeId: "x" });
  });
});
```

> 若 `Conversation` 类型字段与 bridge 不完全一致，测试 mock 对象按 `src/bridge/tauri.ts` 的 `Conversation` 补齐必填字段即可。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/stores/conversation.store.test.ts`

Expected: FAIL（导出/API 不存在）

- [ ] **Step 3: 实现 store**

重写 `src/stores/conversation.store.ts` 关键部分（保留 messages / loadConversations / append / update 逻辑）：

```ts
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist, type PersistStorage } from "zustand/middleware";
import {
  conversationCreate,
  conversationList,
  conversationGetMessages,
  type Conversation,
  type Message,
} from "../bridge/tauri";
import { useProjectStore } from "./project.store";

export type LegacyTabsMigration = { tabs: string[]; activeId: string | null };

interface ConversationStore {
  conversationsByProject: Record<string, Conversation[]>;
  tabsByProject: Record<string, string[]>;
  activeTabByProject: Record<string, string | null>;
  /** One-shot stash from v0 persist; App applies then clearLegacyTabsMigration() */
  legacyTabsMigration: LegacyTabsMigration | null;
  messagesByConversation: Record<string, Message[]>;
  loading: boolean;
  error: string | null;

  loadConversations: (projectId: string) => Promise<void>;
  createConversation: (projectId: string, agentType: string) => Promise<Conversation>;
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  loadMessages: (conversationId: string) => Promise<void>;
  appendMessage: (conversationId: string, message: Message) => void;
  updateMessageContent: (conversationId: string, messageId: string, content: string) => void;
  restoreTabs: (
    projectId: string,
    candidateTabs: string[],
    candidateActiveId: string | null,
    validIds: Set<string>,
  ) => void;
  clearLegacyTabsMigration: () => void;
}

export function selectProjectOpenTabs(
  s: Pick<ConversationStore, "tabsByProject">,
  projectId: string | null | undefined,
): string[] {
  if (!projectId) return [];
  return s.tabsByProject[projectId] ?? [];
}

export function selectProjectActiveTabId(
  s: Pick<ConversationStore, "activeTabByProject">,
  projectId: string | null | undefined,
): string | null {
  if (!projectId) return null;
  return s.activeTabByProject[projectId] ?? null;
}

/** Exported for unit tests; also wired as persist.migrate */
export function migrateConversationPersist(
  persistedState: unknown,
  version: number,
): {
  tabsByProject: Record<string, string[]>;
  activeTabByProject: Record<string, string | null>;
  legacyTabsMigration: LegacyTabsMigration | null;
} {
  const old = (persistedState ?? {}) as {
    openTabs?: string[];
    activeTabId?: string | null;
    tabsByProject?: Record<string, string[]>;
    activeTabByProject?: Record<string, string | null>;
    legacyTabsMigration?: LegacyTabsMigration | null;
  };

  if (version >= 1) {
    return {
      tabsByProject: old.tabsByProject ?? {},
      activeTabByProject: old.activeTabByProject ?? {},
      legacyTabsMigration: old.legacyTabsMigration ?? null,
    };
  }

  const legacy =
    Array.isArray(old.openTabs) && old.openTabs.length > 0
      ? { tabs: old.openTabs, activeId: old.activeTabId ?? null }
      : null;

  return {
    tabsByProject: old.tabsByProject ?? {},
    activeTabByProject: old.activeTabByProject ?? {},
    legacyTabsMigration: old.legacyTabsMigration ?? legacy,
  };
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export const useConversationStore = create<ConversationStore>()(
  persist(
    immer((set) => ({
      conversationsByProject: {},
      tabsByProject: {},
      activeTabByProject: {},
      legacyTabsMigration: null,
      messagesByConversation: {},
      loading: false,
      error: null,

      loadConversations: async (projectId: string) => {
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          const convs = await conversationList(projectId);
          set((s) => {
            s.conversationsByProject[projectId] = convs;
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

      createConversation: async (projectId: string, agentType: string) => {
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          const conv = await conversationCreate(projectId, agentType);
          set((s) => {
            if (!s.conversationsByProject[projectId]) s.conversationsByProject[projectId] = [];
            s.conversationsByProject[projectId].unshift(conv);
            const tabs = s.tabsByProject[projectId] ?? [];
            tabs.push(conv.id);
            s.tabsByProject[projectId] = tabs;
            s.activeTabByProject[projectId] = conv.id;
          });
          return conv;
        } catch (err) {
          set((s) => {
            s.error = errorMessage(err);
          });
          throw err;
        } finally {
          set((s) => {
            s.loading = false;
          });
        }
      },

      switchTab: (id: string) => {
        const projectId = useProjectStore.getState().activeProjectId;
        if (!projectId) return;
        set((s) => {
          s.activeTabByProject[projectId] = id;
        });
      },

      closeTab: (id: string) => {
        const projectId = useProjectStore.getState().activeProjectId;
        if (!projectId) return;
        set((s) => {
          const tabs = (s.tabsByProject[projectId] ?? []).filter((t) => t !== id);
          s.tabsByProject[projectId] = tabs;
          if (s.activeTabByProject[projectId] === id) {
            s.activeTabByProject[projectId] = tabs[tabs.length - 1] || null;
          }
        });
      },

      loadMessages: async (conversationId: string) => {
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          const msgs = await conversationGetMessages(conversationId);
          set((s) => {
            s.messagesByConversation[conversationId] = msgs;
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

      appendMessage: (conversationId: string, message: Message) => {
        set((s) => {
          if (!s.messagesByConversation[conversationId]) s.messagesByConversation[conversationId] = [];
          s.messagesByConversation[conversationId].push(message);
        });
      },

      updateMessageContent: (conversationId: string, messageId: string, content: string) => {
        set((s) => {
          const msg = s.messagesByConversation[conversationId]?.find((m) => m.id === messageId);
          if (msg) msg.content = content;
        });
      },

      restoreTabs: (projectId, candidateTabs, candidateActiveId, validIds) => {
        set((s) => {
          const valid = candidateTabs.filter((id) => validIds.has(id));
          s.tabsByProject[projectId] = valid;
          s.activeTabByProject[projectId] =
            candidateActiveId && valid.includes(candidateActiveId)
              ? candidateActiveId
              : (valid[valid.length - 1] ?? null);
        });
      },

      clearLegacyTabsMigration: () => {
        set((s) => {
          s.legacyTabsMigration = null;
        });
      },
    })),
    {
      name: "nex-conversations",
      version: 1,
      migrate: (persistedState, version) => migrateConversationPersist(persistedState, version),
      partialize: (s) => ({
        tabsByProject: s.tabsByProject,
        activeTabByProject: s.activeTabByProject,
        legacyTabsMigration: s.legacyTabsMigration,
      }),
    },
  ),
);
```

> 注意：若 `persist` 的 `migrate` 类型与返回值抱怨，只返回 partialize 字段对象即可（zustand v5 会 merge）。不要引入未使用的 `PersistStorage` import——上面若 lint 报 unused，删掉该 import。

- [ ] **Step 4: 更新消费者以通过编译（行为仍可临时不完整）**

`MessageList.tsx` / `ChatInput.tsx`：

```ts
import { useProjectStore } from "../../stores/project.store";
import { selectProjectActiveTabId, useConversationStore } from "../../stores/conversation.store";

const activeProjectId = useProjectStore((s) => s.activeProjectId);
const activeTabId = useConversationStore((s) => selectProjectActiveTabId(s, activeProjectId));
```

`TopBar.tsx`：用 `activeProjectId` + `selectProjectOpenTabs` / `selectProjectActiveTabId`；标题查找改为优先 `conversationsByProject[activeProjectId]`。关页签暂仍直接 `removeSession`+`closeTab`（Task 4 再加确认）。

`App.tsx`：把 `openTabs`/`activeTabId`/`restoreTabs` 调用改成带 `projectId` 的新签名（完整 legacy 在 Task 3）。

- [ ] **Step 5: 跑测试通过**

Run: `pnpm test -- src/stores/conversation.store.test.ts`

Expected: PASS

Run: `pnpm exec tsc -b --pretty false`（或项目惯用 typecheck）确认无因删字段导致的错误。

- [ ] **Step 6: Commit**

```bash
git add src/stores/conversation.store.ts src/stores/conversation.store.test.ts src/App.tsx src/features/layout/TopBar.tsx src/features/agent/MessageList.tsx src/features/agent/ChatInput.tsx
git commit -m "feat(conversation): 页签按项目存储并支持 persist 迁移"
```

---

### Task 3: 启动恢复、切项目校验、legacy 迁移落地

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/features/projects/ProjectSelector.tsx`

**Interfaces:**
- Consumes: `restoreTabs`, `clearLegacyTabsMigration`, `legacyTabsMigration`, `loadMessages`, `loadConversations`
- Produces: 启动与切项目时当前项目 tabs 已校验；legacy 一次性写入 `activeProjectId`；**无** `removeSession`

- [ ] **Step 1: 抽取共享恢复 helper（写在 App 旁或 ProjectSelector 同文件上方均可；推荐新建小函数放 `src/stores/conversation.store.ts` 旁的调用约定）**

在 `ProjectSelector.tsx` 与 `App.tsx` 复用同一异步流程。最小做法：在 `conversation.store.ts` **不**加异步；在调用点写：

```ts
async function restoreProjectConversationTabs(projectId: string) {
  const convStore = useConversationStore.getState();
  await convStore.loadConversations(projectId);
  const convs = useConversationStore.getState().conversationsByProject[projectId] ?? [];
  const validIds = new Set(convs.map((c) => c.id));

  const legacy = useConversationStore.getState().legacyTabsMigration;
  if (legacy) {
    const existing = useConversationStore.getState().tabsByProject[projectId] ?? [];
    if (existing.length === 0) {
      convStore.restoreTabs(projectId, legacy.tabs, legacy.activeId, validIds);
    }
    convStore.clearLegacyTabsMigration();
  } else {
    const tabs = useConversationStore.getState().tabsByProject[projectId] ?? [];
    const active = useConversationStore.getState().activeTabByProject[projectId] ?? null;
    convStore.restoreTabs(projectId, tabs, active, validIds);
  }

  const restored = useConversationStore.getState().tabsByProject[projectId] ?? [];
  await Promise.all(restored.map((tabId) => convStore.loadMessages(tabId)));
}
```

将此函数放到 `src/features/projects/restoreProjectConversationTabs.ts`（Create），供 App / ProjectSelector import。

- [ ] **Step 2: 改 App 启动**

替换原 `loadConversations` + `restoreTabs(openTabs…)` 段为：

```ts
await restoreProjectConversationTabs(activeProjectId);
```

保留 `fsWatchStart` / `loadEditorState`。

- [ ] **Step 3: 改 ProjectSelector 切换与打开**

在 `switchProject(p.id)` 与 `openProject` 成功后的路径中：

```ts
await restoreProjectConversationTabs(p.id); // 或 active.id
```

**禁止**在此调用 `useAgentStore.getState().removeSession`。

- [ ] **Step 4: 手动逻辑自检（无浏览器则靠 code review）**

确认：

1. 切项目只改 `activeProjectId` + 恢复该项目 tabs/messages  
2. Agent sessions map 不被清空  

- [ ] **Step 5: Commit**

```bash
git add src/features/projects/restoreProjectConversationTabs.ts src/App.tsx src/features/projects/ProjectSelector.tsx
git commit -m "feat(projects): 启动与切项目按项目恢复会话页签"
```

---

### Task 4: 关闭页签确认对话框

**Files:**
- Create: `src/features/agent/CloseTabConfirmDialog.tsx`
- Modify: `src/features/layout/TopBar.tsx`

**Interfaces:**
- Consumes: `removeSession`, `closeTab`, `sessions[tabId].status`
- Produces: `CloseTabConfirmDialog` props:
  - `open: boolean`
  - `busy: boolean`
  - `status: "idle" | "running" | "waiting" | null`
  - `onCancel: () => void`
  - `onConfirm: () => void`

- [ ] **Step 1: 实现对话框（沿用 NewConversationModal 的 Modal 模式）**

```tsx
import { Button, Modal, ModalContent, ModalHeader, ModalTitle } from "@glinui/ui";

const ACCENT_CTA =
  "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]";

const DANGER_CTA =
  "bg-[var(--error)] text-white hover:opacity-90 dark:bg-[var(--error)] dark:text-white";

interface Props {
  open: boolean;
  busy: boolean;
  status: "idle" | "running" | "waiting" | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function CloseTabConfirmDialog({ open, busy, status, onCancel, onConfirm }: Props) {
  const interrupting = status === "running" || status === "waiting";
  return (
    <Modal open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <ModalContent size="sm">
        <ModalHeader>
          <ModalTitle>关闭对话？</ModalTitle>
        </ModalHeader>
        <p className="text-sm text-[var(--text-secondary)] px-1">
          {interrupting
            ? "该对话的 Agent 仍在运行或等待权限，关闭将中断任务且不可恢复。"
            : "确定关闭此对话页签吗？"}
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={busy}
            className={interrupting ? DANGER_CTA : ACCENT_CTA}
            onClick={onConfirm}
          >
            {busy ? "关闭中…" : interrupting ? "关闭并中断" : "关闭"}
          </Button>
        </div>
      </ModalContent>
    </Modal>
  );
}
```

> 若 `--error` token 不存在，改用现有错误色 class（与 `ProjectSelector` 的 `text-[var(--error)]` 一致即可）。

- [ ] **Step 2: TopBar 接入**

```tsx
const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
const [closing, setClosing] = useState(false);

// × onClick:
onClick={(e) => {
  e.stopPropagation();
  setPendingCloseId(tabId);
}}

// dialog:
<CloseTabConfirmDialog
  open={pendingCloseId !== null}
  busy={closing}
  status={pendingCloseId ? (sessions[pendingCloseId]?.status ?? null) : null}
  onCancel={() => { if (!closing) setPendingCloseId(null); }}
  onConfirm={() => {
    if (!pendingCloseId || closing) return;
    const id = pendingCloseId;
    setClosing(true);
    void (async () => {
      try {
        await removeSession(id);
        closeTab(id);
      } finally {
        setClosing(false);
        setPendingCloseId(null);
      }
    })();
  }}
/>
```

- [ ] **Step 3: 确认 NewConversationModal 失败回滚的 `closeTab` 仍无弹窗**（仅用户点 × 才确认）——无需改 Modal。

- [ ] **Step 4: Commit**

```bash
git add src/features/agent/CloseTabConfirmDialog.tsx src/features/layout/TopBar.tsx
git commit -m "feat(agent): 关闭会话页签前确认并中断 Agent"
```

---

### Task 5: 项目列表与触发器运行态指示

**Files:**
- Modify: `src/features/projects/ProjectSelector.tsx`

**Interfaces:**
- Consumes: `projectSessionIndicators`, `conversationsByProject`, `useAgentStore.sessions`
- Produces: 列表项与 Trigger 上的双色状态点

- [ ] **Step 1: 订阅 sessions 与 conversations**

```tsx
import { useAgentStore } from "../../stores/agent.store";
import { projectSessionIndicators } from "../agent/projectSessionIndicators";

const sessions = useAgentStore((s) => s.sessions);
const conversationsByProject = useConversationStore((s) => s.conversationsByProject);

function StatusDots({ projectId }: { projectId: string }) {
  const ids = (conversationsByProject[projectId] ?? []).map((c) => c.id);
  const { hasRunning, hasWaiting } = projectSessionIndicators(ids, sessions);
  if (!hasRunning && !hasWaiting) return null;
  return (
    <span className="inline-flex items-center gap-1 ml-2">
      {hasRunning && (
        <span
          className="w-2 h-2 rounded-full animate-pulse"
          style={{ backgroundColor: "var(--accent)" }}
          title="Agent running"
        />
      )}
      {hasWaiting && (
        <span
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: "var(--warning)" }}
          title="Agent waiting"
        />
      )}
    </span>
  );
}
```

- [ ] **Step 2: Trigger 与 DropdownMenuItem 渲染**

Trigger 按钮内容：

```tsx
<span className="inline-flex items-center">
  {activeProject?.name || "Open Project"}
  {activeProjectId && <StatusDots projectId={activeProjectId} />}
  <span className="ml-1">▾</span>
</span>
```

每个项目项：

```tsx
<span className="flex items-center justify-between w-full gap-2">
  <span className="truncate">{p.name}</span>
  <StatusDots projectId={p.id} />
</span>
```

- [ ] **Step 3: 确认页签指示器仍仅显示当前项目 tabs（Task 2/4 已保证）**

- [ ] **Step 4: 跑相关测试**

Run: `pnpm test -- src/features/agent/projectSessionIndicators.test.ts src/stores/conversation.store.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/projects/ProjectSelector.tsx
git commit -m "feat(projects): 项目列表显示 Agent running/waiting 指示"
```

---

## 手动验收清单（全部 Task 完成后）

1. 项目 A 开两个会话页签 → 切到 B → TopBar 只显示 B 的页签；再切回 A，A 的页签仍在  
2. A 上跑 Agent → 切到 B → A 仍 running；B 的项目项/A 的项目项有对应色点；切回 A 进度仍在  
3. 关 idle 页签 → 普通确认；关 running → 「关闭并中断」→ 任务停止且页签消失  
4. 重启应用 → 各项目上次打开的页签恢复（有旧 localStorage 时，旧全局 tabs 落到当时 active 项目一次）

---

## Self-Review（写计划时已核对）

| Spec 要求 | Task |
|---|---|
| tabsByProject / activeTabByProject | Task 2 |
| 切项目不碰 Agent | Task 3 |
| persist + 旧字段迁移 | Task 2 + Task 3 |
| 页签 running/waiting 点 | 已有 TopBar；Task 2 保证只渲染当前项目 |
| 项目列表双色点 + 触发器 | Task 5 |
| 关页签一律确认 + removeSession | Task 4 |
| 启动恢复 / 校验失效 id | Task 3 |
| 非目标未纳入 | ✓ |
