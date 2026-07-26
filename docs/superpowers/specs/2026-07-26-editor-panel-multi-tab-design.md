# 编辑器面板增强设计

**日期**: 2026-07-26  
**状态**: 已批准（对话确认）  
**范围**: 文件编辑面板布局/滚动、多标签、路径显示、快捷键保存、自动保存设置、语法高亮

---

## 1. 背景与目标

当前编辑器（`EditorPanel` + `fs.store.editorFile`）为单文件模式：已有 Ctrl/Cmd+S，但标签路径显示在 Windows 上可能不准、无多标签、无自动保存开关、CodeMirror 未挂语言包（无高亮），且内容区高度/滚动在部分布局下异常。

成功标准：

1. 编辑器列高度与左右侧栏一致，代码区可纵向滚动  
2. 标签只显示文件名；悬停显示项目内相对路径  
3. 支持多标签；Ctrl/Cmd+S 保存当前标签；设置中可开关自动保存（停止输入后 debounce）  
4. 常用语言有语法高亮  

---

## 2. 决策摘要

| 项 | 选择 |
|---|---|
| 状态存放 | 扩展现有 `fs.store`（不新建 editor.store） |
| 自动保存 | 停止输入后 debounce（约 1.5s）；设置项默认开启 |
| 关闭脏标签 | 不弹窗；关闭前若仍 dirty 则立刻 flush 保存一次 |
| 高亮语言 | TS/JS、JSON、CSS、HTML、Markdown、Python、Rust、Go、TOML、YAML、Shell；未知扩展纯文本 |
| 编辑器实例 | 切标签用 `key=activePath` 重建（撤销栈按文件隔离，与现状一致） |
| Esc | 仅隐藏面板，不卸载、不清空标签 |

---

## 3. 布局与滚动

- `MainLayout` 中编辑器列已在 `flex-1 overflow-hidden` 行内；外层保持 `h-full` / `flex flex-col`  
- 内容区使用 `flex-1 min-h-0`，避免子项按内容无限撑高导致无法滚动  
- CodeMirror：`height="100%"`，父级 `overflow-hidden`（或等价），由编辑器内部滚动  
- 标签栏固定顶部；错误条 / stale 条在标签下方、编辑器上方  

---

## 4. 多标签状态（`fs.store`）

### 4.1 形状

将单一 `editorFile` 替换为：

- `openFiles: EditorFile[]` — 打开顺序（标签栏顺序）  
- `activePath: string | null` — 当前编辑文件  

`EditorFile` 字段保持现有语义：`path`、`content`、`isText`、`size`、`draft`、`dirty`、`stale`。

面板是否挂载：`openFiles.length > 0`（替代 `!!editorFile`）。可见性仍由 `ui.store.editorVisible` 控制（Esc 隐藏）。

### 4.2 API 行为

| 方法 | 行为 |
|---|---|
| `openFile(path)` | 已在 `openFiles` 中 → 设为 active 并 `setEditorVisible(true)`，不重读盘、不丢 draft；否则 `fsReadFile` 后追加并激活 |
| `switchFile(path)` | 仅切换 `activePath`（已打开的） |
| `closeFile(path)` | 若该文件 dirty → 先 `saveFile(path)`（flush）；从列表移除；若关掉的是 active → 激活相邻标签（优先右侧，否则左侧）；列表空 → `activePath=null` 且 `setEditorVisible(false)` |
| `closeEditor()` | 关闭全部：对每个 dirty 文件 flush 后清空列表（或逐个 `closeFile`） |
| `setDraft(draft)` | 只更新 active 文件 |
| `saveFile(path?)` | 默认 active；无 dirty 则 no-op |
| `syncExternalChange(paths)` | 对 `openFiles` 中命中的每个 path：dirty → 标 stale；clean → 静默重载 |
| `reloadEditor` / `dismissStale` | 作用于 active（或指定 path，与现 banner 一致） |

### 4.3 标签 UI

- 文案：文件名，用同时支持 `/` 与 `\` 的 basename 工具函数  
- `title`（原生 tooltip）：相对当前项目根的路径；无法相对化时退回绝对路径  
- dirty：●；关闭：×（点击不触切换）  
- 点击标签：`switchFile`  

---

## 5. 保存与自动保存

### 5.1 快捷键

保留现有窗口级监听：Ctrl/Cmd+S → `preventDefault` → 若 active dirty 则 `saveFile()`。有 Radix dialog 打开时仍让出（现有逻辑）。

### 5.2 设置

`settings.store` / `settings.json`：

- Key：`editor.autoSave`  
- Type：`boolean`  
- Default：`true`  
- Setter：`setEditorAutoSave(v: boolean)`  

`SettingsPanel` 增加「编辑器」分区，开关「自动保存」；说明文案可写：停止输入约 1.5 秒后自动写入磁盘。

### 5.3 Debounce 行为

- 仅当 `editor.autoSave === true` 且 active 文件 dirty 时调度  
- 每次 `setDraft` 重置计时器；约 **1500ms** 无新输入后调用 `saveFile(activePath)`  
- 计时器挂在模块或 store 侧，面板卸载（Esc 隐藏仍挂载）时不丢；切标签时：旧文件若有 pending debounce，应 **立即 flush** 再切，避免丢写  
- 关标签：与决策一致，关闭前 flush dirty（覆盖 debounce 窗口）  
- 自动保存失败：错误条展示信息，保留 dirty，可手动再存  

---

## 6. 语法高亮

- 依赖：`@codemirror/lang-*`（与现有 `@uiw/react-codemirror` 兼容的版本）  
- 按扩展名映射（小写）：

| 扩展名 | 语言 |
|---|---|
| `ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs` | javascript/typescript |
| `json` | json |
| `css` | css |
| `html`, `htm` | html |
| `md`, `markdown` | markdown |
| `py` | python |
| `rs` | rust |
| `go` | go |
| `toml` | toml |
| `yml`, `yaml` | yaml |
| `sh`, `bash` | shell |

- 未匹配：无 language extension（纯文本）  
- 主题：继续用现有 `EditorView.theme` CSS 变量方案；高亮色依赖 CodeMirror 默认 highlight styles（可加轻量 `HighlightStyle` 若对比度不够，属实现细节）  

---

## 7. 错误处理

- 读文件失败：不加入 `openFiles`，设置 `error`；错误条可见  

- 写文件失败（手动或自动）：`error` 条 + dirty 保留  
- 外部变更：按文件 stale；banner 仅针对 active 脏文件展示  

---

## 8. 测试与验收

**自动化（优先 store）：**

- 多开 / 切换 / 关闭顺序与 active 选择  
- 关脏文件会调用写盘（mock `fsWriteFile`）  
- 自动保存：fake timer，1.5s 后写盘；关闭 autoSave 后不写  

**手动：**

- 编辑器高度与侧栏对齐，长文件可滚动  
- 标签仅文件名，悬停为项目相对路径  
- Ctrl/Cmd+S；设置开关自动保存  
- 若干扩展名可见高亮  

---

## 9. 非目标（本轮不做）

- 标签会话跨重启持久化  
- 分屏编辑、预览 Markdown  
- 关闭确认对话框  
- 全语言包 / LSP / 诊断  
- 每标签常驻多个 CodeMirror 实例  

---

## 10. 主要改动面

| 区域 | 文件 |
|---|---|
| Store | `src/stores/fs.store.ts` |
| 设置 | `src/stores/settings.store.ts`, `src/features/settings/SettingsPanel.tsx` |
| UI | `src/features/editor/EditorPanel.tsx`（+ 可选 `language.ts` / `path.ts` 小工具） |
| 挂载条件 | `src/App.tsx`（`openFiles.length`） |
| 布局 | `MainLayout` / `EditorPanel` 的 `min-h-0` 等（按需微调） |
| 依赖 | `package.json` 增加 CodeMirror lang 包 |
