import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Plus, X } from "lucide-react";
import { useTerminalStore, getReplay, setLiveSink } from "../../stores/terminal.store";
import { useProjectStore } from "../../stores/project.store";
import { Button } from "@glinui/ui";

export function TerminalPanel() {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const { sessions, activeSessionId, error, create, kill, setActive, clearError } = useTerminalStore();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  // Construct the single xterm instance once; session switches reuse it via
  // reset + replay (effect below) instead of dispose/reconstruct.
  useEffect(() => {
    if (!termRef.current) return;

    // Terminal foreground/cursor follow the active theme so text stays
    // readable on both light and dark glass backgrounds.
    const cs = getComputedStyle(document.documentElement);
    const foreground = cs.getPropertyValue("--text-primary").trim() || "rgba(255,255,255,0.9)";
    const cursor = cs.getPropertyValue("--accent").trim() || "rgba(124,138,255,1)";

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "JetBrains Mono, Menlo, monospace",
      allowTransparency: true,
      // No `background` key: xterm 6 silently rejects "transparent"; the DOM renderer + globals.css handle transparency, and a future canvas renderer must not fall back to opaque black.
      theme: { foreground, cursor },
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    // Read the session at call time via getState() — never capture
    // activeSessionId/write/resize from render scope (stale closures).
    term.onData((data) => {
      const { activeSessionId, write } = useTerminalStore.getState();
      if (activeSessionId) write(activeSessionId, data);
    });
    term.onResize(({ cols, rows }) => {
      const { activeSessionId, resize } = useTerminalStore.getState();
      if (activeSessionId) resize(activeSessionId, cols, rows);
    });

    xtermRef.current = term;

    // Render live output for the ACTIVE session immediately; background
    // tabs buffer only (their replay runs on switch). getState() at call
    // time — never capture activeSessionId.
    setLiveSink((id, data) => {
      if (useTerminalStore.getState().activeSessionId === id) term.write(data);
    });

    const el = termRef.current;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) fitAddon.fit();
    });
    observer.observe(el);

    return () => { setLiveSink(null); observer.disconnect(); term.dispose(); xtermRef.current = null; };
  }, []);

  // Replay the active session's buffered output: on first mount (the
  // app-scope listener captured the shell banner before this component
  // existed) and on every tab switch. term.reset() clears the previous
  // session; the buffer is the single source of truth.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term || !activeSessionId) return;
    term.reset();
    term.write(getReplay(activeSessionId));
  }, [activeSessionId]);

  const handleCreate = () => {
    if (project) void create(project.path);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[color:var(--border-subtle)]">
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => setActive(s.id)}
            className={`px-3 py-1.5 text-xs rounded-[var(--radius-sm)] transition-colors ${s.id === activeSessionId ? "bg-[var(--overlay-active)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:bg-[var(--overlay-ghost)]"}`}
          >
            {s.title}
          </button>
        ))}
        <Button size="sm" variant="ghost" disabled={!project} onClick={handleCreate}><Plus size={12} /></Button>
        {activeSessionId && (
          <Button size="sm" variant="ghost" onClick={() => void kill(activeSessionId)}><X size={12} /></Button>
        )}
      </div>
      {error && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-[var(--error)] bg-[var(--error)]/10">
          <span className="flex-1 truncate">{error}</span>
          <Button size="sm" variant="ghost" onClick={clearError}><X size={12} /></Button>
        </div>
      )}
      {/* The xterm host stays mounted for the tray's whole lifetime —
          construction is a mount-once effect, so unmounting the host while
          no project is open would leave a dead terminal when one is opened
          later (the effect never re-runs). The empty state overlays it. */}
      <div className="relative flex-1 overflow-hidden">
        <div ref={termRef} className="h-full p-3" />
        {!project && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-tertiary)]">
            未打开项目
          </div>
        )}
      </div>
    </div>
  );
}
