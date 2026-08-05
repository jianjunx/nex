/**
 * Composer 斜杠/@ 建议面板的打开状态（模块级，供命令注册表读取）。
 * Esc 落在 Composer 输入框时：面板打开 → 交给输入框关面板；
 * 面板关闭 → editor.close（双击 Esc 关编辑器面板）照常生效。
 */
let composerSuggestOpen = false;

export function setComposerSuggestOpen(open: boolean): void {
  composerSuggestOpen = open;
}

export function isComposerSuggestOpen(): boolean {
  return composerSuggestOpen;
}
