import { useEffect, useMemo, useState } from "react";
import type { EditorView } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from "@codemirror/search";
import {
  CaseSensitive,
  ChevronLeft,
  ChevronRight,
  Regex,
  Replace,
  WholeWord,
  X,
} from "lucide-react";

export const SEARCH_SYNC_EVENT = "nex-search-sync";

function matchStats(view: EditorView): { current: number; total: number } {
  const query = getSearchQuery(view.state);
  if (!query.valid || !query.search) return { current: 0, total: 0 };

  let total = 0;
  let current = 0;
  const head = view.state.selection.main.head;
  const cursor = query.getCursor(view.state);
  for (let m = cursor.next(); !m.done; m = cursor.next()) {
    total += 1;
    if (m.value.from <= head && head <= m.value.to) current = total;
  }
  return { current, total };
}

function ToggleChip({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] transition-colors ${
        active
          ? "bg-[var(--overlay-active)] text-[var(--accent)]"
          : "text-[var(--text-tertiary)] hover:bg-[var(--overlay-hover)] hover:text-[var(--text-secondary)]"
      }`}
    >
      {children}
    </button>
  );
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-secondary)] hover:bg-[var(--overlay-hover)]"
    >
      {children}
    </button>
  );
}

export function EditorFindBar({ view }: { view: EditorView }) {
  const initial = getSearchQuery(view.state);
  const [searchText, setSearchText] = useState(initial.search);
  const [replaceText, setReplaceText] = useState(initial.replace);
  const [caseSensitive, setCaseSensitive] = useState(initial.caseSensitive);
  const [wholeWord, setWholeWord] = useState(initial.wholeWord);
  const [regexp, setRegexp] = useState(initial.regexp);
  const [showReplace, setShowReplace] = useState(false);
  const [stats, setStats] = useState(() => matchStats(view));

  const applyQuery = (partial: {
    search?: string;
    replace?: string;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regexp?: boolean;
  }) => {
    const q = new SearchQuery({
      search: partial.search ?? searchText,
      replace: partial.replace ?? replaceText,
      caseSensitive: partial.caseSensitive ?? caseSensitive,
      wholeWord: partial.wholeWord ?? wholeWord,
      regexp: partial.regexp ?? regexp,
    });
    view.dispatch({ effects: setSearchQuery.of(q) });
  };

  useEffect(() => {
    const sync = () => {
      const q = getSearchQuery(view.state);
      setSearchText(q.search);
      setReplaceText(q.replace);
      setCaseSensitive(q.caseSensitive);
      setWholeWord(q.wholeWord);
      setRegexp(q.regexp);
      setStats(matchStats(view));
    };
    view.dom.addEventListener(SEARCH_SYNC_EVENT, sync);
    sync();
    return () => view.dom.removeEventListener(SEARCH_SYNC_EVENT, sync);
  }, [view]);

  const resultLabel = useMemo(() => {
    if (!searchText) return "";
    if (stats.total === 0) return "无结果";
    return `${stats.current || 0}/${stats.total}`;
  }, [searchText, stats]);

  return (
    <div className="flex flex-col gap-1.5 bg-[var(--glass-2-surface)] px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] bg-[var(--glass-1-surface)] px-1.5">
          <input
            {...{ "main-field": "true" }}
            value={searchText}
            placeholder="查找"
            onChange={(e) => {
              const v = e.target.value;
              setSearchText(v);
              applyQuery({ search: v });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) findPrevious(view);
                else findNext(view);
                setStats(matchStats(view));
              }
              // Esc: handled in capture by EditorPanel (close find → then hide panel)
            }}
            className="min-w-0 flex-1 bg-transparent py-1 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
          <ToggleChip
            active={caseSensitive}
            title="区分大小写"
            onClick={() => {
              const v = !caseSensitive;
              setCaseSensitive(v);
              applyQuery({ caseSensitive: v });
            }}
          >
            <CaseSensitive size={12} />
          </ToggleChip>
          <ToggleChip
            active={wholeWord}
            title="全词匹配"
            onClick={() => {
              const v = !wholeWord;
              setWholeWord(v);
              applyQuery({ wholeWord: v });
            }}
          >
            <WholeWord size={12} />
          </ToggleChip>
          <ToggleChip
            active={regexp}
            title="正则表达式"
            onClick={() => {
              const v = !regexp;
              setRegexp(v);
              applyQuery({ regexp: v });
            }}
          >
            <Regex size={12} />
          </ToggleChip>
        </div>

        <ToggleChip active={showReplace} title="切换替换" onClick={() => setShowReplace((v) => !v)}>
          <Replace size={12} />
        </ToggleChip>

        <div className="mx-0.5 h-4 w-px bg-[var(--border-subtle)]" />

        <IconBtn
          title="上一个"
          onClick={() => {
            findPrevious(view);
            setStats(matchStats(view));
          }}
        >
          <ChevronLeft size={14} />
        </IconBtn>
        <IconBtn
          title="下一个"
          onClick={() => {
            findNext(view);
            setStats(matchStats(view));
          }}
        >
          <ChevronRight size={14} />
        </IconBtn>
        <span className="min-w-[3.5rem] text-center text-[11px] tabular-nums text-[var(--text-tertiary)]">
          {resultLabel}
        </span>
        <IconBtn title="关闭" onClick={() => closeSearchPanel(view)}>
          <X size={12} />
        </IconBtn>
      </div>

      {showReplace && (
        <div className="flex items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] bg-[var(--glass-1-surface)] px-1.5">
            <input
              value={replaceText}
              placeholder="替换"
              onChange={(e) => {
                const v = e.target.value;
                setReplaceText(v);
                applyQuery({ replace: v });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  replaceNext(view);
                  setStats(matchStats(view));
                }
                // Esc: handled in capture by EditorPanel
              }}
              className="min-w-0 flex-1 bg-transparent py-1 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
            />
          </div>
          <button
            type="button"
            title="替换"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              replaceNext(view);
              setStats(matchStats(view));
            }}
            className="h-6 shrink-0 rounded-[var(--radius-sm)] px-2 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--overlay-hover)]"
          >
            替换
          </button>
          <button
            type="button"
            title="全部替换"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              replaceAll(view);
              setStats(matchStats(view));
            }}
            className="h-6 shrink-0 rounded-[var(--radius-sm)] px-2 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--overlay-hover)]"
          >
            全部替换
          </button>
        </div>
      )}
    </div>
  );
}
