import { useEffect, useState } from "react";
import { Search, FileCode, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useFsStore } from "../../stores/fs.store";
import { useProjectStore } from "../../stores/project.store";

const DEBOUNCE_MS = 300;

// Read at effect time (App.tsx pattern) so the debounced-search effect only
// depends on `query`.
function activeProjectPath(): string | null {
  const { projects, activeProjectId } = useProjectStore.getState();
  return projects.find((p) => p.id === activeProjectId)?.path ?? null;
}

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const { searchResults, searching, search, openFile } = useFsStore();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  // Debounced live search; clearing the input clears the results.
  useEffect(() => {
    const path = activeProjectPath();
    if (!path || !query.trim()) {
      useFsStore.getState().clearSearch();
      return;
    }
    const timer = setTimeout(() => { void useFsStore.getState().search(path, query); }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="flex flex-col h-full">
      <div className="py-4 px-1">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files and content…"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (project && query.trim()) void search(project.path, query);
            }
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto pb-4 px-1">
        {!project ? (
          <p className="text-sm text-[var(--text-tertiary)] px-2 py-1">Open a project to search.</p>
        ) : searching ? (
          <p className="flex items-center gap-2 text-sm text-[var(--text-tertiary)] px-2 py-1">
            <Loader2 size={14} className="animate-spin" /> Searching…
          </p>
        ) : !query.trim() ? (
          <p className="flex items-center gap-2 text-sm text-[var(--text-tertiary)] px-2 py-1">
            <Search size={14} /> Type to search file names and text content.
          </p>
        ) : searchResults.length === 0 ? (
          <p className="text-sm text-[var(--text-tertiary)] px-2 py-1">No results.</p>
        ) : (
          <div className="space-y-1">
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
