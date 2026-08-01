import type { Command, KeyCombo } from "./types";
import { isFindBarOpen } from "./editorKeybindings";
import { noteCloseEsc } from "./keybindingHostState";
import { useUiStore } from "../stores/ui.store";
import { useFsStore } from "../stores/fs.store";
import { useProjectStore } from "../stores/project.store";
import { useGitStore } from "../stores/git.store";
import { useClipboardStore } from "../stores/clipboard.store";

const k = (key: string, o: { primary?: boolean; alt?: boolean; shift?: boolean } = {}): KeyCombo => ({
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
    // No `when`: the dispatcher already gates this to the Escape combo. The
    // find-bar case is handled inside run (record the cadence, then yield to
    // CodeMirror's own keymap which closes the bar).
    run: () => {
      if (isFindBarOpen()) {
        noteCloseEsc(); // keep cadence; CodeMirror's own keymap closes the bar
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
    defaultKey: k("`", { primary: true }),
    run: () => useUiStore.getState().toggleTerminal(),
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
    when: () => {
      const sel = useFsStore.getState().selectedPath;
      if (!sel) return false;
      // Don't steal from CodeMirror editor
      if (document.activeElement?.closest('.cm-editor, .cm-content')) return false;
      return true;
    },
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
    when: () => {
      const sel = useFsStore.getState().selectedPath;
      if (!sel) return false;
      if (document.activeElement?.closest('.cm-editor, .cm-content')) return false;
      return true;
    },
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
      const sel = useFsStore.getState().selectedPath;
      if (!sel) return false;
      if (document.activeElement?.closest('.cm-editor, .cm-content')) return false;
      return true;
    },
    run: () => {
      const fs = useFsStore.getState();
      const sel = fs.selectedPath;
      if (!sel) return;
      const entries = useClipboardStore.getState().entries;
      // Determine target directory
      const targetDir = sel in fs.nodesByDir ? sel : sel.replace(/[/\\][^/\\]*$/, "");
      if (entries.some((e) => e.isCut)) {
        void fs.moveEntries(entries.map((e) => e.path), targetDir);
        useClipboardStore.getState().clear();
      } else {
        void fs.copyEntries(entries.map((e) => e.path), targetDir);
      }
    },
  },
  {
    id: "files.rename",
    title: "重命名文件/目录",
    category: "文件树",
    defaultKey: k("f2"),
    when: () => {
      const sel = useFsStore.getState().selectedPath;
      if (!sel) return false;
      if (document.activeElement?.closest('.cm-editor, .cm-content')) return false;
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
      const sel = useFsStore.getState().selectedPath;
      if (!sel) return false;
      if (document.activeElement?.closest('.cm-editor, .cm-content')) return false;
      return true;
    },
    run: () => {
      const sel = useFsStore.getState().selectedPath;
      if (sel) void useFsStore.getState().deleteEntry(sel);
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
