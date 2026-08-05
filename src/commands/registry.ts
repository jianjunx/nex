import type { Command, KeyCombo } from "./types";
import { isFindBarOpen, closeFindBar } from "./editorKeybindings";
import { noteCloseEsc } from "./keybindingHostState";
import { useUiStore } from "../stores/ui.store";
import { useFsStore } from "../stores/fs.store";
import { useProjectStore } from "../stores/project.store";
import { useGitStore } from "../stores/git.store";
import { useClipboardStore } from "../stores/clipboard.store";
import { isSameOrDescendant } from "../features/editor/pathUtils";
import { isComposerSuggestOpen } from "../features/agent/composerPanelState";

/** Keep in sync with KeybindingHost.INPUT_SELECTOR (avoid circular import). */
const INPUT_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

function isTypingInInput(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement ? !!el.closest(INPUT_SELECTOR) : false;
}

function isInCodeMirror(): boolean {
  return !!document.activeElement?.closest(".cm-editor, .cm-content");
}

/** File-tree clipboard shortcuts must not steal from text inputs, the editor,
 *  or an active text selection (e.g. copying from a conversation card). */
function hasTextSelection(): boolean {
  const sel = window.getSelection();
  return !!sel && sel.toString().length > 0;
}

function filesClipboardWhen(): boolean {
  const sel = useFsStore.getState().selectedPath;
  if (!sel) return false;
  if (isInCodeMirror()) return false;
  if (isTypingInInput()) return false;
  if (hasTextSelection()) return false;
  return true;
}

/** 焦点在文件树新建/重命名内联输入框（Esc 应取消输入而非关面板）。 */
function isInFileTreeEditInput(): boolean {
  return !!document.activeElement?.closest("[data-filetree-edit-input]");
}

/** 焦点在 Composer 输入框。 */
function isInComposerInput(): boolean {
  return !!document.activeElement?.closest("[data-composer-input]");
}

const k = (
  key: string,
  o: { primary?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): KeyCombo => ({
  key,
  ...o,
});

// Handlers read live state via getState() so the static table never goes stale.
const COMMANDS: Command[] = [
  {
    id: "editor.save",
    title: "保存文件",
    category: "编辑器",
    defaultKey: k("keys", { primary: true }),
    run: () => {
      const fs = useFsStore.getState();
      const active = fs.openFiles.find((f) => f.path === fs.activePath);
      if (active?.dirty) void fs.saveFile();
    },
  },
  {
    id: "editor.close",
    title: "关闭编辑器面板",
    category: "编辑器",
    defaultKey: k("escape"),
    // 文件树新建/重命名输入框内的 Esc 交给输入框自己（取消编辑）；
    // Composer 建议面板（斜杠指令/@文件）打开时 Esc 先关面板；
    // 否则会被白名单旁路吞掉导致无法取消/关闭。
    when: () => {
      if (isInFileTreeEditInput()) return false;
      if (isInComposerInput() && isComposerSuggestOpen()) return false;
      return true;
    },
    // The find-bar case is handled inside run (record the cadence, then yield to
    // CodeMirror's own keymap which closes the bar).
    run: () => {
      if (isFindBarOpen()) {
        // Focus inside the find bar's HTML input never reaches CodeMirror's
        // own keymap — close the bar explicitly. Focus inside the editor
        // content yields to CodeMirror's keymap (cadence kept either way).
        noteCloseEsc();
        if (!isInCodeMirror()) closeFindBar();
        return;
      }
      if (noteCloseEsc()) useUiStore.getState().setEditorVisible(false);
    },
  },
  {
    id: "view.toggleSidebar",
    title: "切换侧栏",
    category: "视图",
    defaultKey: k("keyb", { primary: true }),
    run: () => useUiStore.getState().toggleSidePanel(),
  },
  {
    id: "terminal.toggle",
    title: "切换终端",
    category: "视图",
    // Physical Ctrl+` on all platforms (VS Code / PRD); not Cmd+` on macOS.
    defaultKey: k("`", { ctrl: true }),
    run: () => useUiStore.getState().toggleTerminal(),
  },
  {
    id: "workbench.closeActiveTab",
    title: "关闭当前页签（按焦点区分文件/会话）",
    category: "会话",
    defaultKey: k("keyw", { primary: true }),
    // Allow while typing so Cmd/Ctrl+W closes the tab instead of the window.
    // 焦点在编辑器面板 → 关文件页签；在会话面板/Composer → 关会话页签；
    // 其它位置不生效。
    run: () => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && el.closest("[data-editor-area]")) {
        const fs = useFsStore.getState();
        if (fs.activePath) void fs.closeFile(fs.activePath);
        return;
      }
      if (el instanceof HTMLElement && el.closest("[data-conversation-area]")) {
        useUiStore.getState().requestCloseActiveTab();
      }
    },
  },
  {
    id: "search.focus",
    title: "聚焦搜索",
    category: "搜索",
    defaultKey: k("keyf", { primary: true, shift: true }),
    run: () => useUiStore.getState().requestSearchFocus(),
  },
  {
    id: "scm.focus",
    title: "聚焦源代码管理",
    category: "Git",
    defaultKey: k("keyg", { primary: true, shift: true }),
    run: () => useUiStore.getState().setSidePanelTab("git"),
  },
  {
    id: "scm.commit",
    title: "提交（提交框）",
    category: "Git",
    defaultKey: k("enter", { primary: true }),
    // Only meaningful while the SCM commit input is focused; doubles as a
    // guard so a user-rebound bare "enter" cannot eat Return in other inputs.
    when: () => !!document.activeElement?.closest("[data-scm-commit-input]"),
    run: () => {
      const { projects, activeProjectId } = useProjectStore.getState();
      const path = projects.find((p) => p.id === activeProjectId)?.path;
      if (path) void useGitStore.getState().commitWith(path, "commit");
    },
  },
  {
    id: "files.focus",
    title: "聚焦文件树",
    category: "视图",
    defaultKey: k("keye", { primary: true, shift: true }),
    run: () => useUiStore.getState().setSidePanelTab("files"),
  },
  {
    id: "files.copy",
    title: "复制文件/目录",
    category: "文件树",
    defaultKey: k("keyc", { primary: true }),
    when: () => filesClipboardWhen(),
    run: () => {
      const sel = useFsStore.getState().selectedPath;
      if (sel) useClipboardStore.getState().setEntries([{ path: sel, isCut: false }]);
    },
  },
  {
    id: "files.cut",
    title: "剪切文件/目录",
    category: "文件树",
    defaultKey: k("keyx", { primary: true }),
    when: () => filesClipboardWhen(),
    run: () => {
      const sel = useFsStore.getState().selectedPath;
      if (sel) useClipboardStore.getState().setEntries([{ path: sel, isCut: true }]);
    },
  },
  {
    id: "files.paste",
    title: "粘贴文件/目录",
    category: "文件树",
    defaultKey: k("keyv", { primary: true }),
    when: () => {
      if (!useClipboardStore.getState().hasEntries()) return false;
      return filesClipboardWhen();
    },
    run: () => {
      const fs = useFsStore.getState();
      const sel = fs.selectedPath;
      if (!sel) return;
      const entries = useClipboardStore.getState().entries;
      // Determine target directory
      const targetDir = sel in fs.nodesByDir ? sel : sel.replace(/[/\\][^/\\]*$/, "");
      const sources = entries.map((e) => e.path);
      // Refuse paste of a directory into itself / a descendant.
      if (sources.some((src) => isSameOrDescendant(targetDir, src))) return;
      if (entries.some((e) => e.isCut)) {
        void fs.moveEntries(sources, targetDir);
        useClipboardStore.getState().clear();
      } else {
        void fs.copyEntries(sources, targetDir);
      }
    },
  },
  {
    id: "files.rename",
    title: "重命名文件/目录",
    category: "文件树",
    defaultKey: k("f2"),
    when: () => {
      if (!useFsStore.getState().selectedPath) return false;
      if (isInCodeMirror()) return false;
      if (isTypingInInput()) return false;
      return true;
    },
    run: () => {
      const sel = useFsStore.getState().selectedPath;
      if (sel) useFsStore.getState().setPendingRename(sel);
    },
  },
  {
    id: "files.delete",
    title: "删除文件/目录",
    category: "文件树",
    defaultKey: k("delete"),
    when: () => {
      if (!useFsStore.getState().selectedPath) return false;
      if (isInCodeMirror()) return false;
      if (isTypingInInput()) return false;
      return true;
    },
    run: () => {
      const sel = useFsStore.getState().selectedPath;
      if (sel) useFsStore.getState().requestDeleteEntry(sel);
    },
  },
  {
    id: "files.undo",
    title: "撤销文件树操作",
    category: "文件树",
    defaultKey: k("keyz", { primary: true }),
    when: () => {
      if (isInCodeMirror()) return false;
      if (isTypingInInput()) return false;
      if (hasTextSelection()) return false;
      return true;
    },
    run: () => {
      void useFsStore.getState().undoFsOperation();
    },
  },
  {
    id: "view.openSettings",
    title: "打开设置",
    category: "视图",
    defaultKey: k(",", { primary: true }),
    // 只有"打开"：关闭交给 Esc/遮罩（radix）。对话框打开时 host 全让行，
    // 一个"切换"命令的关半永远不可达，故命名为 open。
    run: () => useUiStore.getState().openSettings(),
  },
  {
    id: "workbench.newConversation",
    title: "新建会话",
    category: "会话",
    defaultKey: k("keyn", { primary: true, shift: true }),
    // 下拉由 TopBar 内的 NewConversationDropdown 受控渲染（ui.store.newConversationOpen
    // 为唯一事实源）；命令只翻转标志位，Ctrl/Cmd+Shift+N 即可全局开关。
    run: () => useUiStore.getState().toggleNewConversation(),
  },
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function getCommand(id: string): Command | undefined {
  return BY_ID.get(id);
}

export function listCommands(): Command[] {
  return COMMANDS.slice();
}
