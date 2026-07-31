import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileCode, Loader2, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFsStore } from "../../stores/fs.store";
import { useProjectStore } from "../../stores/project.store";

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

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 折叠态供 T7 分组视图消费；本任务结果区保持平铺，暂不读取。
  // 显式引用以免 tsc noUnusedLocals / lint unused-vars 门槛报错。
  void collapsed;
  void setCollapsed;
  const searchResults = useFsStore((s) => s.searchResults);
  const searching = useFsStore((s) => s.searching);
  const searchError = useFsStore((s) => s.searchError);
  const searchOptions = useFsStore((s) => s.searchOptions);
  const search = useFsStore((s) => s.search);
  const clearSearch = useFsStore((s) => s.clearSearch);
  const setSearchOptions = useFsStore((s) => s.setSearchOptions);
  const openFile = useFsStore((s) => s.openFile);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const fileCount = useMemo(
    () => new Set(searchResults.map((m) => m.path)).size,
    [searchResults],
  );

  return (
    <div className="flex flex-col h-full">
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
      </div>

      {/* 搜索行 + 三枚匹配规则开关 */}
      <div className="py-2 px-1">
        <div className="flex items-center gap-1">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索…"
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

      {/* 可选过滤行预留位（glob，v1 不接后端） */}
      <div className="px-1 pb-2">
        <Input
          disabled
          placeholder="要包含的文件（glob）— 后续版本支持"
          title="后续版本支持"
          aria-label="文件过滤"
          className="opacity-60"
        />
      </div>

      {/* 统计条 */}
      {query.trim() && !regexError && (
        <div className="flex items-center gap-2 px-3 pb-1 text-xs text-[var(--text-tertiary)]">
          {searching ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              <span>搜索中…</span>
            </>
          ) : (
            <span>{searchResults.length} 个结果 / {fileCount} 个文件</span>
          )}
        </div>
      )}

      {/* 结果区（T7 换成分组视图） */}
      <div className="flex-1 overflow-y-auto pb-4 px-1">
        {!project ? (
          <p className="text-sm text-[var(--text-tertiary)] px-2 py-1">打开项目后即可搜索。</p>
        ) : !query.trim() ? (
          <p className="flex items-center gap-2 text-sm text-[var(--text-tertiary)] px-2 py-1">
            <Search size={14} /> 输入关键词搜索文件名与内容。
          </p>
        ) : searchResults.length === 0 && !searching ? (
          <p className="text-sm text-[var(--text-tertiary)] px-2 py-1">无结果。</p>
        ) : (
          <div className="space-y-1" data-testid="search-result-list">
            {searchResults.map((m, i) => (
              <button
                key={`${m.path}:${m.line ?? 0}:${i}`}
                onClick={() => void openFile(m.path)}
                className="w-full text-left px-3 py-2 rounded-[var(--radius-md)] hover:bg-[var(--glass-2-surface)] transition-colors"
              >
                <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                  <FileCode size={13} className="flex-none text-[var(--text-tertiary)]" />
                  <span className="truncate">{m.name}</span>
                  {m.line != null && (
                    <span className="flex-none text-xs text-[var(--text-tertiary)]">:{m.line}</span>
                  )}
                </div>
                <div className="pl-5 text-xs text-[var(--text-tertiary)] truncate">{m.path}</div>
                {m.text && (
                  <div className="pl-5 text-xs font-mono text-[var(--text-secondary)] truncate">{m.text}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
