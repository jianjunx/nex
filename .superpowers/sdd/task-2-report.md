# Task 2 报告：fs.store 多标签

## 状态

**DONE**

## 交付物

| 文件 | 操作 |
|------|------|
| `src/stores/fs.store.ts` | 修改：`editorFile` → `openFiles[]` + `activePath`；新增 `switchFile` / `closeFile`；`closeEditor`/`saveFile` 签名更新 |
| `src/stores/fs.store.editor.test.ts` | 新建（brief  verbatim） |
| `src/App.tsx` | 修改：挂载条件改为 `openFiles.length > 0` |
| `src/features/editor/EditorPanel.tsx` | 修改：按 `openFiles`/`activePath` 取当前文件；关闭改为 `closeFile`；快捷键查 active |

## 接口（Produces）

- `EditorFile`: `path, content, isText, size, draft, dirty, stale`
- `openFiles: EditorFile[]`
- `activePath: string | null`
- `openFile(filePath)` — 已打开则仅激活；否则读盘后 push + 激活 + 显示面板；失败只写 `error`
- `switchFile(filePath)` — 本任务仅切换 `activePath`（无 autosave flush）
- `closeFile(filePath)` — dirty 时 `await saveFile`；删除后选右邻否则左邻；空列表 hide
- `closeEditor()` — 对每个 dirty `await saveFile`，清空并 hide
- `setDraft(draft)` — 仅改 active
- `saveFile(filePath?)` — `path ?? activePath`；写后若仍同 draft 意图则清 dirty
- `syncExternalChange` — 遍历命中的 open files：dirty→stale，clean→静默重载
- `reloadEditor` / `dismissStale` — 作用于 active

本任务**未实现** autosave debounce（Task 3）；测试中 mock 了 `settings.store`（`editorAutoSave: false`）。

## TDD 证据

### RED（Step 2）

**命令：**

```text
pnpm test -- src/stores/fs.store.editor.test.ts
```

**输出（节选）：**

```text
 ❯ src/stores/fs.store.editor.test.ts (6 tests | 6 failed)
 FAIL  ... openFile appends...
 AssertionError: expected [] to have a length of 1 but got +0
 FAIL  ... closeFile on dirty...
 TypeError: useFsStore.getState(...).closeFile is not a function
 Test Files  1 failed (1)
      Tests  6 failed (6)
```

**结论：** 失败符合预期（`openFiles` / `closeFile` 等尚未存在）。

### GREEN（Step 6）

**命令：**

```text
pnpm test -- src/stores/fs.store.editor.test.ts
pnpm exec tsc --noEmit
```

**输出（节选）：**

```text
 Test Files  1 passed (1)
      Tests  6 passed (6)
tsc_exit:0
```

## 提交

- **BASE：** `d1b6e7a`
- **SHA：** `b9167a3`
- **Subject：** `feat(editor): fs.store 支持多标签打开与关闭`

## 自检

1. **与 brief 一致性：** 测试文件 verbatim；App 挂载条件 verbatim；store API 与行为要点对齐；EditorPanel 最小改动使 tsc 通过，无完整标签栏（Task 4）。
2. **TDD 顺序：** 先写测试 → 确认 6 FAIL → 再改 store/App/EditorPanel → 6 PASS + tsc 0。
3. **范围：** 未实现 autosave debounce；tree/search 逻辑保留；删除全部 `editorFile` 引用。
4. **`closeEditor` 签名：** 由同步 `void` 变为 `Promise<void>`；当前无其它调用方（EditorPanel 改用 `closeFile`）。
5. **save 失败与关闭（已修复）：** 见下方「Review 修复」。

## 测试摘要

1 个测试文件，7 个用例：open/re-open、多文件+switch、setDraft/save、close dirty+邻接激活、**closeFile 保存失败保留标签**、关闭最后文件 hide、syncExternalChange dirty/stale 与 clean reload。

## Concerns

- `switchFile` 本任务无 flush；Task 3 需接 debounce flush。
- UI 仍为单标签外观；完整标签栏属 Task 4。

## Review 修复：保存失败不丢弃 dirty 标签

**问题：** `saveFile` 捕获写盘错误后不向上传递；`closeFile` / `closeEditor` 在 `await saveFile` 后仍移除标签，导致失败写盘时丢弃未保存草稿。

**改动：**

1. `saveFile` → `Promise<boolean>`：无目标/非 dirty/`write` 成功返回 `true`；`fsWriteFile` 失败写 `error` 并返回 `false`。
2. `closeFile`：dirty 且 `saveFile` 返回 `false` 时直接 return，保留标签、dirty、error bar。
3. `closeEditor`：逐个尝试 dirty 保存后，仅移除已 clean 的文件；若仍有 dirty 则保留并保持面板可见。
4. 新增测试：`closeFile keeps dirty tab when save fails`（`fsWriteFile` reject）。

### 验证证据

**命令：**

```text
pnpm test -- src/stores/fs.store.editor.test.ts
pnpm exec tsc --noEmit
```

**输出（节选）：**

```text
 Test Files  1 passed (1)
      Tests  7 passed (7)
tsc_exit:0
```

### 提交

- **Subject：** `fix(editor): 关闭标签时保存失败则保留标签`
