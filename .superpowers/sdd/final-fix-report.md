# Final Fix Report: 会话列表失败时不覆盖已持久化页签

## Status

**FIXED**

## Finding

`loadConversations` 失败时仍吞掉错误并继续执行；`restoreProjectConversationTabs` 用空 `conversationsByProject[projectId]` 得到空 `validIds`，再调用 `restoreTabs`，会把该项目已持久化的 tabs 清空并写回 persist。

## Fix

1. **`loadConversations`** 改为 `Promise<Conversation[] | null>`：成功返回列表；失败时仍写入 `error`（与既有 load 模式一致），并 `return null`。
2. **`restoreProjectConversationTabs`** 仅在 `convs !== null` 时执行 `restoreTabs` / legacy 迁移 / `loadMessages`；列表失败时直接 `return`，不改动 `tabsByProject[projectId]`。
3. **回归测试**：
   - store：`loadConversations returns null on list failure`
   - helper：`does not overwrite persisted tabs when conversation list fails`

## Files Changed

- `src/stores/conversation.store.ts`
- `src/stores/conversation.store.test.ts`
- `src/features/projects/restoreProjectConversationTabs.ts`
- `src/features/projects/restoreProjectConversationTabs.test.ts`（新建）

## Commit

- Subject: `fix(projects): 会话列表失败时不覆盖已持久化的页签`

## Test Commands + Output

### Unit tests

**Command:**

```text
pnpm test -- src/stores/conversation.store.test.ts src/features/projects/restoreProjectConversationTabs.test.ts
```

**Output:**

```text
$ vitest run "src/stores/conversation.store.test.ts" "src/features/projects/restoreProjectConversationTabs.test.ts"

 RUN  v4.1.10 D:/projects/nex/.worktrees/project-scoped-agent-tabs


 Test Files  2 passed (2)
      Tests  6 passed (6)
   Start at  22:19:28
   Duration  244ms (transform 92ms, setup 0ms, import 150ms, tests 12ms, environment 0ms)
```

### Typecheck

**Command:**

```text
pnpm exec tsc -b --pretty false
```

**Output:**

```text
(exit 0, no diagnostics)
```

## Self-check

- 列表失败路径不再调用 `restoreTabs` / `clearLegacyTabsMigration` / `loadMessages`。
- 成功路径行为不变：校验 validIds → legacy 或已有 tabs → 并行 loadMessages。
- `createConversation` 仍 throw；`loadConversations` 返回 `null` 以匹配既有“记 error 不抛”模式。
