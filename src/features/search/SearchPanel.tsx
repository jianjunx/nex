import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileCode, Loader2, RefreshCw, Replace, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useFsStore } from "../../stores/fs.store";
import { useUiStore } from "../../stores/ui.store";
import { useProjectStore } from "../../stores/project.store";
import { relativeToProject } from "../editor/pathUtils";
import { buildHighlightRegExp, matchRanges, type MatchRange } from "./searchHighlight";

const DEBOUNCE_MS = 300;

// Read at effect/handler time (App.tsx pattern) so renders don't subscribe
// the panel to the whole project store.
function activeProjectPath(): string | null {
  const { projects, activeProjectId } = useProjectStore.getState();
  return projects.find((p) => p.id === activeProjectId)?.path ?? null;
}

/** Aa / ab| / .* 三枚匹配规则开关；aria-pressed 表达状态。 */
function FlagToggle({ pressed, title, onClick, children }: {
  pressed: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={`h-7 min-w-7 px-1 rounded-[var(--radius-sm)] text-xs font-mono transition-colors ${
        pressed
          ? "bg-[var(--overlay-active)] text-[var(--text-primary)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--overlay-hover)]"
      }`}
    >
      {children}
    </button>
  );
}

/** 按区间把行文本切成普通段 + <mark> 高亮段。 */
function Highlighted({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={start} className="rounded-[2px] bg-[color-mix(in_srgb,var(--accent)_28%,transparent)] text-[var(--text-primary)]">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showReplace, setShowReplace] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchResults = useFsStore((s) => s.searchResults);
  const searching = useFsStore((s) => s.searching);
  const searchError = useFsStore((s) => s.searchError);
  const searchOptions = useFsStore((s) => s.searchOptions);
  const search = useFsStore((s) => s.search);
  const clearSearch = useFsStore((s) => s.clearSearch);
  const setSearchOptions = useFsStore((s) => s.setSearchOptions);
  const openFile = useFsStore((s) => s.openFile);
  const replacePreview = useFsStore((s) => s.replacePreview);
  const replacing = useFsStore((s) => s.replacing);
  const previewReplace = useFsStore((s) => s.previewReplace);
  const applyReplace = useFsStore((s) => s.applyReplace);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  const groups = useMemo(() => {
    const map = new Map<string, { path: string; name: string; matches: typeof searchResults }>();
    for (const m of searchResults) {
      let g = map.get(m.path);
      if (!g) {
        g = { path: m.path, name: m.name, matches: [] };
        map.set(m.path, g);
      }
      g.matches.push(m);
    }
    return [...map.values()];
  }, [searchResults]);

  const toggleGroup = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const highlightRe = useMemo(
    () => buildHighlightRegExp(query.trim(), searchOptions),
    [query, searchOptions],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const searchFocusRequest = useUiStore((s) => s.searchFocusRequest);

  // 非法正则快速失败：与后端合成规则近似的 JS 预校验，命中则不发起搜索。
  // Rust regex 方言更宽，极少数「Rust 合法 / JS 非法」模式仍会到达后端，
  // 其拒绝经 searchError 以同样的行内形式呈现（后端恒为匹配权威）。
  const regexError = useMemo(() => {
    if (!searchOptions.regex || !query.trim()) return null;
    try {
      new RegExp(query);
      return null;
    } catch {
      return `无效的正则表达式: ${query}`;
    }
  }, [query, searchOptions.regex]);
  const inlineError = regexError ?? searchError;

  // Debounced live search; clearing the input clears the results.
  useEffect(() => {
    const path = activeProjectPath();
    if (!path || !query.trim()) {
      clearSearch();
      return;
    }
    if (regexError) return; // 非法正则不搜
    const timer = setTimeout(() => { void search(path, query); }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, searchOptions, regexError, search, clearSearch]);

  // search.focus 命令经计数触发聚焦；0 为初值，挂载时不抢焦点。
  useEffect(() => {
    if (searchFocusRequest > 0) inputRef.current?.focus();
  }, [searchFocusRequest]);

  // 查询或结果变化时复位导航游标。
  useEffect(() => {
    setActiveIndex(-1);
  }, [query, searchResults]);

  const fileCount = useMemo(
    () => new Set(searchResults.map((m) => m.path)).size,
    [searchResults],
  );

  // 面板本地 Enter/Shift+Enter：在扁平化结果序列中移动游标并跳转编辑器。
  // 全局分发器在输入框焦点下让行，二者不会双触发。
  const stepResult = (dir: 1 | -1) => {
    if (searchResults.length === 0) return;
    const next = (activeIndex + dir + searchResults.length) % searchResults.length;
    setActiveIndex(next);
    const m = searchResults[next];
    void openFile(m.path, m.line != null ? { line: m.line } : undefined);
  };

  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 带修饰键的 Enter（Ctrl+Alt+Enter 替换全部）交给根容器处理器，这里不介入
    if (e.key !== "Enter" || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    if (e.shiftKey) stepResult(-1);
    else stepResult(1);
  };

  // 替换后自动重搜：写盘 → fs-changed → syncExternalChange 静默/stale 同步
  // 已打开文件（不抑制 watcher）；面板随即用同一 query/options 刷新结果。
  const reSearch = () => {
    const path = activeProjectPath();
    if (path && query.trim()) void search(path, query);
  };

  const startReplaceAll = async () => {
    const path = activeProjectPath();
    if (!path || !query.trim() || inlineError) return;
    await previewReplace(path, query, replacement);
    const preview = useFsStore.getState().replacePreview;
    if (preview && preview.total > 0) setConfirmOpen(true);
  };

  const confirmReplaceAll = async () => {
    setConfirmOpen(false);
    const path = activeProjectPath();
    if (!path) return;
    const result = await applyReplace(path, query, replacement, undefined); // 显式 undefined=全项目（paths=null）
    if (result) reSearch();
  };

  const replaceInFile = async (filePath: string) => {
    const path = activeProjectPath();
    if (!path || !query.trim() || inlineError) return;
    const result = await applyReplace(path, query, replacement, { paths: [filePath] });
    if (result) reSearch();
  };

  const replaceFirstInFile = async (filePath: string) => {
    const path = activeProjectPath();
    if (!path || !query.trim() || inlineError) return;
    const result = await applyReplace(path, query, replacement, { paths: [filePath], limitPerFile: 1 });
    if (result) reSearch();
  };

  return (
    <div
      className="flex flex-col h-full"
      onKeyDown={(e) => {
        // 面板作用域：替换全部快捷键不进全局注册表
        if (e.key === "Enter" && e.ctrlKey && e.altKey) {
          e.preventDefault();
          void startReplaceAll();
        }
      }}
    >
      {/* 顶工具条 */}
      <div className="flex items-center gap-1 px-2 pt-2">
        <span className="flex-1 text-xs font-medium text-[var(--text-secondary)]">搜索</span>
        <Button
          variant="ghost"
          size="icon-xs"
          title="重新搜索"
          onClick={() => {
            const path = activeProjectPath();
            if (path && query.trim() && !regexError) void search(path, query);
          }}
        >
          <RefreshCw size={13} />
        </Button>
        <Button variant="ghost" size="icon-xs" title="清除" onClick={() => setQuery("")}>
          <X size={13} />
        </Button>
        <Button variant="ghost" size="icon-xs" title="折叠全部" onClick={() => setCollapsed(new Set(groups.map((g) => g.path)))}>
          <ChevronsDownUp size={13} />
        </Button>
        <Button variant="ghost" size="icon-xs" title="展开全部" onClick={() => setCollapsed(new Set())}>
          <ChevronsUpDown size={13} />
        </Button>
      </div>

      {/* 搜索行 + 展开替换 + 三枚匹配规则开关 */}
      <div className="py-2 px-1">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            title={showReplace ? "折叠替换" : "展开替换"}
            aria-expanded={showReplace}
            aria-label={showReplace ? "折叠替换" : "展开替换"}
            onClick={() => setShowReplace((v) => !v)}
          >
            {showReplace ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </Button>
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="输入关键词搜索文件名与内容。"
            aria-label="搜索"
            className={inlineError ? "border-[var(--error)] focus-visible:ring-[var(--error)]" : ""}
          />
          <FlagToggle
            pressed={searchOptions.caseSensitive}
            title="区分大小写"
            onClick={() => setSearchOptions({ caseSensitive: !searchOptions.caseSensitive })}
          >
            Aa
          </FlagToggle>
          <FlagToggle
            pressed={searchOptions.wholeWord}
            title="全字匹配"
            onClick={() => setSearchOptions({ wholeWord: !searchOptions.wholeWord })}
          >
            ab|
          </FlagToggle>
          <FlagToggle
            pressed={searchOptions.regex}
            title="使用正则表达式"
            onClick={() => setSearchOptions({ regex: !searchOptions.regex })}
          >
            .*
          </FlagToggle>
        </div>
        {inlineError && (
          <p role="alert" className="mt-1 px-1 text-xs text-[var(--error)]">{inlineError}</p>
        )}
      </div>

      {/* 替换行：默认折叠，由搜索行左侧箭头展开 */}
      {showReplace && (
        <div className="px-1 pb-2 pl-7">
          <div className="flex items-center gap-1">
            <Input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder="替换…"
              aria-label="替换"
            />
            <Button
              size="sm"
              variant="ghost"
              title="替换全部"
              disabled={replacing || !query.trim() || !!inlineError}
              onClick={() => void startReplaceAll()}
            >
              替换全部
            </Button>
          </div>
        </div>
      )}

      {/* 统计条 */}
      {query.trim() && !regexError && (
        <div className="flex items-center gap-2 px-3 pb-1 text-xs text-[var(--text-tertiary)]">
          {searching ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              <span>搜索中…</span>
            </>
          ) : (
            <span key={`${searchResults.length}:${fileCount}`} className="animate-in fade-in-0 duration-150">
              {searchResults.length} 个结果 / {fileCount} 个文件
            </span>
          )}
        </div>
      )}

      {/* 结果区（按文件分组视图） */}
      <div className="flex-1 overflow-y-auto pb-4 px-1">
        {!project ? (
          <p className="text-sm text-[var(--text-tertiary)] px-2 py-1">打开项目后即可搜索。</p>
        ) : !query.trim() ? null : searchResults.length === 0 && !searching ? (
          <p className="text-sm text-[var(--text-tertiary)] px-2 py-1">无结果。</p>
        ) : (
          <div data-testid="search-result-list">
            {groups.map((g, gi) => {
              const isCollapsed = collapsed.has(g.path);
              const rowOffset = groups.slice(0, gi).reduce((n, x) => n + x.matches.length, 0);
              return (
                <div key={g.path} className="group/header relative mb-1">
                  {/* 组头：折叠箭头 + 图标 + 名称 + 相对路径 + 计数徽标 */}
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleGroup(g.path)}
                    className="flex w-full items-center gap-1.5 px-2 py-1 rounded-[var(--radius-sm)] hover:bg-[var(--overlay-hover)] text-left"
                  >
                    <ChevronRight size={12} className={`flex-none text-[var(--text-tertiary)] transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
                    <FileCode size={13} className="flex-none text-[var(--text-tertiary)]" />
                    <span className="flex-none max-w-[40%] truncate text-sm text-[var(--text-primary)]">{g.name}</span>
                    <span className="truncate text-xs text-[var(--text-tertiary)]">{relativeToProject(g.path, project?.path)}</span>
                    <span data-count-badge className="ml-auto flex-none rounded-full bg-[var(--overlay-ghost)] px-1.5 text-xs text-[var(--text-secondary)]">{g.matches.length}</span>
                  </button>
                  {/* 整文件替换：悬浮显示，直写该文件全部匹配 */}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="替换本文件全部匹配"
                    disabled={replacing}
                    className="absolute right-1 top-1 opacity-0 group-hover/header:opacity-100"
                    onClick={() => void replaceInFile(g.path)}
                  >
                    <Replace size={12} />
                  </Button>
                  {/* 折叠高度过渡：grid-rows 技巧（CSS 见 globals.css，T10） */}
                  <div className="search-collapse" style={{ gridTemplateRows: isCollapsed ? "0fr" : "1fr" }}>
                    <div className="search-collapse-inner">
                      {g.matches.map((m, i) => (
                        <button
                          key={`${m.path}:${m.line ?? 0}:${i}`}
                          onClick={() => void openFile(m.path, m.line != null ? { line: m.line } : undefined)}
                          className={`group/row search-stagger relative w-full text-left pl-7 pr-7 py-1 rounded-[var(--radius-sm)] hover:bg-[var(--glass-2-surface)] transition-colors ${rowOffset + i === activeIndex ? "bg-[var(--overlay-ghost)]" : ""}`}
                          style={{ animationDelay: `${Math.min(rowOffset + i, 19) * 25}ms` }}
                        >
                          {m.line != null ? (
                            <>
                              <span className="mr-2 text-xs text-[var(--text-tertiary)]">{m.line}</span>
                              <span className="text-xs font-mono text-[var(--text-secondary)]">
                                <Highlighted text={m.text} ranges={matchRanges(m.text, highlightRe)} />
                              </span>
                            </>
                          ) : (
                            <span className="text-xs text-[var(--text-tertiary)] italic">文件名匹配</span>
                          )}
                          <span
                            role="button"
                            title="替换本文件首个匹配"
                            className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] opacity-0 group-hover/row:opacity-100 hover:text-[var(--text-primary)]"
                            onClick={(e) => {
                              e.stopPropagation();
                              void replaceFirstInFile(g.path);
                            }}
                          >
                            <Replace size={11} />
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 替换全部确认 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>替换全部</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1">
                <p>将修改 {replacePreview?.files.length ?? 0} 个文件共 {replacePreview?.total ?? 0} 处。此操作直接写盘，请确认。</p>
                {replacePreview?.truncated && (
                  <p className="text-[var(--warning)]">结果已达上限，仅替换前 {replacePreview.total} 处所在文件。</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmReplaceAll()}>确认替换</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
