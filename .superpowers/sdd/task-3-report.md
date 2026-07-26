# Task 3 报告：自动保存设置 + debounce

## 状态

**DONE**

## 交付物

| 文件 | 操作 |
|------|------|
| `src/stores/settings.store.ts` | 修改：`editorAutoSave`（默认 `true`）+ `setEditorAutoSave`；key `"editor.autoSave"` |
| `src/stores/fs.store.ts` | 修改：模块级 1500ms debounce；`setDraft` 调度；`switchFile` flush 前文件；`closeFile`/`saveFile` 成功清 timer |
| `src/stores/fs.store.editor.test.ts` | 修改：可变 `editorAutoSave` mock + 3 个 autosave 用例 |
| `src/features/settings/SettingsPanel.tsx` | 修改：外观与终端之间增加「编辑器 / 自动保存」Switch |

## 接口（Produces）

- `editorAutoSave: boolean`（default `true`）
- `setEditorAutoSave(v: boolean): void`
- settings key `"editor.autoSave"`
- 模块级 `Map<path, ReturnType<typeof setTimeout>>`，`AUTO_SAVE_MS = 1500`
- 内部：`scheduleAutoSave` / `flushAutoSave` / `clearAutoSaveTimer`（未导出）
- `saveFile` 仍返回 `Promise<boolean>`（未改签名）

## TDD 证据

### RED（Step 2）

**命令：**

```text
pnpm test -- src/stores/fs.store.editor.test.ts
```

**输出（节选）：**

```text
 ❯ src/stores/fs.store.editor.test.ts (10 tests | 2 failed)
     × autosaves dirty active file after 1500ms when enabled
     × switchFile flushes pending autosave for previous file
 AssertionError: expected "vi.fn()" to be called with arguments: [ '/p/a.ts', 'a!' ]
 Number of calls: 0
 Test Files  1 failed (1)
      Tests  2 failed | 8 passed (10)
```

**结论：** 失败符合预期（debounce / flush 尚未实现）；「setting off」用例因默认不调度而通过。

### GREEN（Step 6）

**命令：**

```text
pnpm test -- src/stores/fs.store.editor.test.ts
pnpm exec tsc --noEmit
```

**输出（节选）：**

```text
 Test Files  1 passed (1)
      Tests  10 passed (10)
tsc exit: 0
```

## 提交

- **BASE：** `85371fd`
- **SHA：** `9027aae`
- **Subject：** `feat(editor): 设置页自动保存与 1.5s debounce`

## 自检

1. **与 brief 一致性：** settings key/默认值、`AUTO_SAVE_MS=1500`、setDraft 调度、switchFile flush 前文件、closeFile 清 timer、SettingsPanel Switch 均对齐。
2. **TDD 顺序：** 先扩测试 → 确认 2 FAIL → 再改 settings/fs/SettingsPanel → 10 PASS + tsc 0。
3. **范围：** 未改标签栏 UI（Task 4）；未改 `saveFile` 返回类型。
4. **`openFile` 再激活：** FileTree/Search 走 `openFile`，已打开路径仅改 `activePath`，**不** flush 前文件（brief 只要求 `switchFile`）。前文件 timer 仍会到期写入，无丢数据，仅无即时 flush。

## 测试摘要

1 文件 10 用例：原有 7 个多标签行为 + autosave 1500ms 启用、关闭时不写、`switchFile` flush 前文件。

## Concerns

- `openFile` 复用已打开标签时不 flush（与 `switchFile` 不对称）；Task 4 标签点击应走 `switchFile`，或后续统一再激活路径的 flush。
- `closeEditor` 未显式 `clearAutoSaveTimer`；成功保存后残留 timer 调用 `saveFile` 会早退，无害但可清理。
- `setDraft` 在内容回到 clean 时仍会调度一次无害的 timer（`saveFile` no-op）。

---

## Review fix：openFile flush

**Finding：** `openFile` 切换 `activePath`（再激活已打开 / 打开新文件）未 flush 前文件 pending autosave；FileTree/Search 走 `openFile`，需与 `switchFile` 对齐。

**Fix：** 在 `openFile` 改 `activePath` 前，若 `previous` 存在且不同于目标，`await flushAutoSave(previous)`。新增用例：编辑 A + autosave on → `openFile(B)`（未满 1500ms）→ 断言 `fsWriteFile` 写 A。

**验证：**

```text
pnpm test -- src/stores/fs.store.editor.test.ts
pnpm exec tsc --noEmit
 Test Files  1 passed (1)
      Tests  11 passed (11)
tsc exit: 0
```

**提交：** `fix(editor): openFile 切换时 flush 自动保存`
