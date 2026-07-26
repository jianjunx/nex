# Task 6 report — 手动验收

## Automated gates (controller, 2026-07-26)

- `pnpm test`: 3 files / 16 tests PASS
- `pnpm exec tsc --noEmit`: exit 0
- `pnpm lint` (oxlint): only the 3 pinned exhaustive-deps warnings (App/GitPanel/FileTree); no new editor warnings

## GUI checklist (requires running the feature branch)

Worktree: `D:\projects\nex\.worktrees\feat-editor-panel-multi-tab`  
Branch: `feat/editor-panel-multi-tab`

Run: `pnpm tauri dev` from the worktree (main checkout’s running instance will NOT include these commits until merge).

| # | Check | Status |
|---|---|---|
| 1 | 长文件等高 + 滚动 | Deferred to user |
| 2 | 多标签 basename + 悬停相对路径 | Deferred to user |
| 3 | Ctrl/Cmd+S | Deferred to user |
| 4 | 自动保存 ON 1.5s | Covered by store tests; GUI deferred |
| 5 | 自动保存 OFF | Covered by store tests; GUI deferred |
| 6 | 关脏标签 flush | Covered by store tests; GUI deferred |
| 7 | `.ts` / `.rs` / `.py` / `.md` 高亮 | language.ts unit tests; GUI deferred |
| 8 | Esc hide + re-open draft | Deferred to user |

## Conclusion

Task 6 automated portion complete. GUI smoke remains for the user after merge or by running tauri from the worktree.

---

## Final whole-branch fix — 关闭自动保存时取消待写入 (2026-07-26)

### Finding
关闭 `editor.autoSave` 后，已调度的 1500ms timer 仍会调用 `saveFile`。

### Fix
1. `scheduleAutoSave` 回调内再次检查 `editorAutoSave`；为 false 则直接 return。
2. 抽出 `src/stores/editorAutosave.ts`（timer Map + `clearAllAutoSaveTimers`），`setEditorAutoSave(false)` 时清空全部 pending timers（避免 settings ↔ fs 循环依赖）。
3. Bonus：`setDraft` 仅在 dirty 时 schedule；变回 clean 时 clear timer。

### Tests
- `disabling autosave cancels already-scheduled timers`
- `timer callback skips save when autosave was turned off`
- `pnpm test`: 3 files / 18 tests PASS
- `pnpm exec tsc --noEmit`: exit 0

### Commit
`fix(editor): 关闭自动保存时取消待写入`
