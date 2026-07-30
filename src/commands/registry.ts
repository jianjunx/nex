// src/commands/registry.ts
import type { Command, KeyCombo } from "./types";
import { isFindBarOpen } from "./editorKeybindings";
import { noteCloseEsc } from "./keybindingHostState";
import { useUiStore } from "../stores/ui.store";
import { useFsStore } from "../stores/fs.store";

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
    defaultKey: k("backquote", { primary: true }),
    run: () => useUiStore.getState().toggleTerminal(),
  },
  {
    id: "search.focus",
    title: "聚焦搜索",
    category: "搜索",
    defaultKey: k("keyf", { primary: true, shift: true }),
    run: () => useUiStore.getState().setSidePanelTab("search"),
  },
  {
    id: "scm.focus",
    title: "聚焦源代码管理",
    category: "Git",
    defaultKey: k("keyg", { primary: true, shift: true }),
    run: () => useUiStore.getState().setSidePanelTab("git"),
  },
  {
    id: "files.focus",
    title: "聚焦文件树",
    category: "视图",
    defaultKey: k("keye", { primary: true, shift: true }),
    run: () => useUiStore.getState().setSidePanelTab("files"),
  },
  {
    id: "workbench.newConversation",
    title: "新建会话",
    category: "会话",
    // Opens the new-conversation dropdown in Plan 6; for now it is a no-op
    // placeholder so the binding shows in the editor and is reserveable.
    defaultKey: k("keyn", { primary: true, shift: true }),
    run: () => {
      /* wired in Plan 6 */
    },
  },
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function getCommand(id: string): Command | undefined {
  return BY_ID.get(id);
}

export function listCommands(): Command[] {
  return COMMANDS.slice();
}
