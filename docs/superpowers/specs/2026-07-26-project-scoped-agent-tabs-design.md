# 项目级 Agent 会话页签设计

**日期**: 2026-07-26  
**状态**: 已批准（对话确认）  
**范围**: 会话页签按项目隔离并持久化；切项目不中断 Agent；项目列表与页签运行态指示；关页签确认后移除会话

---

## 1. 背景与目标

PRD / 既有设计要求：多项目下可切换项目，对话跟随项目；后台 Agent 继续执行；页签与项目列表可见运行状态。

当前缺口：

- `conversationsByProject` 已按项目存列表，但 `openTabs` / `activeTabId` 是**全局**的，切项目不会换成该项目的页签  
- Agent `sessions` 按 `conversationId` 保活（正确），但 UI 未按项目过滤页签，项目下拉无运行指示  
- 关页签直接 `removeSession` + `closeTab`，无确认，易误关

成功标准：

1. 页签列表与激活页签跟随当前项目，并按项目持久化（重启可恢复）  
2. 切走项目不 cancel / kill 后台 Agent；切回可见最新状态  
3. 页签与项目列表显示 `running` / `waiting` 指示（双色，可并存）  
4. 关闭页签一律先确认；确认后移除会话（kill）并关页签  

---

## 2. 决策摘要

| 项 | 选择 |
|---|---|
| 页签存储 | `tabsByProject` + `activeTabByProject`（方案 1） |
| 切项目 | 只切换 UI 指针与对话列表；不碰 `agent.sessions` |
| 持久化 | 本地 persist 整张 map；旧全局 `openTabs`/`activeTabId` 启动时迁移 |
| 项目指示器 | B：有 `running` 显示强调色脉冲点；有 `waiting` 显示警告色点（可同时有） |
| 关页签 | A：一律确认；运行中文案强调中断任务；确认后 `removeSession` + `closeTab` |

---

## 3. 数据模型（`conversation.store`）

### 3.1 形状

```ts
tabsByProject: Record<string, string[]>;       // projectId -> open conversation ids
activeTabByProject: Record<string, string | null>;
```

删除（或仅作派生、不再持久化）全局：

- `openTabs: string[]`
- `activeTabId: string | null`

### 3.2 读写约定

- 所有读写以 `useProjectStore.getState().activeProjectId` 为当前项目（无 active 时 no-op）  
- `createConversation`：写入该项目的 tabs，并设为 active  
- `switchTab(id)` / `closeTab(id)`：只改当前项目槽  
- UI：`openTabs = tabsByProject[activeProjectId] ?? []`，`activeTabId = activeTabByProject[activeProjectId] ?? null`  

可用 selector / 小 helper，避免各处手写。

### 3.3 持久化

```ts
partialize: (s) => ({
  tabsByProject: s.tabsByProject,
  activeTabByProject: s.activeTabByProject,
})
```

**迁移（一次）**：若 hydrate 到旧字段 `openTabs` / `activeTabId`，且存在 `activeProjectId`，则：

```
tabsByProject[activeProjectId] = openTabs
activeTabByProject[activeProjectId] = activeTabId
```

然后丢弃旧字段（zustand `migrate` 或首次读时兼容）。

### 3.4 启动恢复（`App.tsx`）

1. `loadProjects` → 校验 `activeProjectId`  
2. `loadConversations(activeProjectId)`  
3. 用该项目对话 id 集合校验 `tabsByProject[activeProjectId]`（过滤失效 id）  
4. 修正 `activeTabByProject`；`loadMessages` 打开的 tabs  

切项目时：`loadConversations` +（可选）校验该项目 tabs；**不**调用 `removeSession`。

---

## 4. Agent 与切换

- `agent.sessions` 继续以 `conversationId` 为键；与项目无关  
- `switchProject` / `openProject`：**禁止**因切换而 `cancel` / `removeSession`  
- 后台会话的 notification / permission 继续写入对应 conversation 的消息与 session status  
- 权限 modal：仍可全局弹出（现有行为）；不因项目不可见而丢弃队列（保持现有 FIFO）  

关闭页签确认后：

1. `await removeSession(conversationId)`（无 session 则 no-op）  
2. `closeTab(conversationId)`  

---

## 5. UI 指示器

### 5.1 页签（TopBar）

仅渲染当前项目 tabs。

| session.status | 指示 |
|---|---|
| `running` | `var(--accent)` 脉冲小圆点 |
| `waiting` | `var(--warning)` 静态小圆点 |
| `idle` / 无 | 无点 |

### 5.2 项目列表（ProjectSelector）

对每个项目 `p`：

- 取 `conversationsByProject[p.id]` 的 id 列表  
- 查 `agent.sessions[id].status`  
- 任一 `running` → 强调色脉冲点  
- 任一 `waiting` → 警告色点（可与 running 并排）  

**触发器**（当前项目按钮）同样显示当前项目的聚合状态，便于未展开下拉时看到后台任务。

conversation → project：优先用对话记录上的 `project_id`（若 bridge 类型已有）；否则用 `conversationsByProject` 反查。

---

## 6. 关闭页签确认

- **时机**：用户点击页签 ×（以及任何「关闭当前对话页签」入口，若有）  
- **一律确认**（含 idle）  
- 文案建议：  
  - `running` / `waiting`：标题「关闭对话？」正文「该对话的 Agent 仍在运行或等待权限，关闭将中断任务且不可恢复。」主按钮「关闭并中断」  
  - `idle` / 无 session：标题「关闭对话？」正文「确定关闭此对话页签吗？」主按钮「关闭」  
- 取消：什么都不做  
- 实现：GlinUI / 现有 `AlertDialog` 模式；确认完成前禁用重复点击  

---

## 7. 主要改动面

| 区域 | 文件 |
|---|---|
| Store | `src/stores/conversation.store.ts`（形状、persist、migrate、API） |
| 启动 / 切换 | `src/App.tsx`、`src/features/projects/ProjectSelector.tsx` |
| 页签 UI + 确认 | `src/features/layout/TopBar.tsx`（+ 可选 `CloseTabConfirmDialog`） |
| 项目指示 | `ProjectSelector.tsx`（读 agent.store） |
| 测试 | `conversation.store` 切项目 / persist；指示器聚合纯函数可单测 |

---

## 8. 测试与验收

**自动化**

- 项目 A 开 tabs，切到 B，A 的 tabs 不变且 UI 只显示 B  
- create/close 只影响当前项目槽  
- 旧 persist 迁移到 `tabsByProject[activeProjectId]`  
- `projectRunningIndicators(projectId)`：running/waiting 聚合  

**手动**

- A 跑 Agent → 切到 B → A 仍在跑；项目列表 A 有脉冲点；切回 A 页签与进度仍在  
- 关 idle 页签弹确认；关 running 页签确认后任务停止  

---

## 9. 非目标

- 关闭/删除整个项目并批量 kill（无现成入口则不做）  
- 终端会话按项目隔离的本次改动  
- 系统托盘 / OS 级后台任务通知  
- 改 ACP 后端协议  

---

## 10. 与既有文档关系

补齐并落实 `docs/prd.md` 多项目条款与 `2026-07-24-nex-design.md` §7「切换项目列表刷新 / Agent 不变 / Tab 指示器」；新增「关页签确认」与「按项目持久化 tabs」为明确实现约束。
