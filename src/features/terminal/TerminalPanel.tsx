import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Plus, X } from "lucide-react";
import { useTerminalStore, getReplay, setLiveSink } from "../../stores/terminal.store";
import { useSettingsStore } from "../../stores/settings.store";
import { useProjectStore } from "../../stores/project.store";
import { Button } from "@glinui/ui";

export function TerminalPanel() {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const { sessions, activeSessionId, loading, error, create, kill, setActive, clearError } = useTerminalStore();
  const settingsVersion = useTerminalStore((s) => s.settingsVersion);
  const terminalShell = useSettingsStore((s) => s.terminalShell);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  // Open = usable: the tray mounts only when the terminal is toggled visible
  // (SidePanel gates it on terminalVisible), so creating a session on mount
  // makes "open the terminal" immediately yield a live shell instead of an
  // empty black box that waits for a manual "+". A manual kill of the last
  // session does NOT respawn (this effect won't re-run); reopening the tray
  // remounts and respawns, which matches "open = usable".
  const autoCreatedFor = useRef<string | null>(null);

  // Construct the single xterm instance; session switches reuse it via
  // reset + replay (effect below) instead of dispose/reconstruct.
  // Rebuilt when settingsVersion bumps (settings.store setters) — the
  // module-level output buffers survive the dispose, and the replay effect
  // below restores the visible content.
  useEffect(() => {
    if (!termRef.current) return;

    // Terminal foreground/cursor follow the active theme so text stays
    // readable on both light and dark glass backgrounds.
    const cs = getComputedStyle(document.documentElement);
    const foreground = cs.getPropertyValue("--text-primary").trim() || "rgba(255,255,255,0.9)";
    const cursor = cs.getPropertyValue("--accent").trim() || "rgba(124,138,255,1)";

    // Live settings read at construction time via getState() (no stale
    // closures, no extra effect deps).
    const { terminalFontSize, terminalFontFamily, terminalScrollback } = useSettingsStore.getState();

    const term = new Terminal({
      fontSize: terminalFontSize,
      fontFamily: terminalFontFamily,
      scrollback: terminalScrollback,
      allowTransparency: true,
      // Transparent background so the glass shows through. NOTE: OMITTING the
      // background key does NOT give transparency — xterm then paints its
      // default OPAQUE black, which on the light theme hides the dark
      // foreground (black-on-black). The CSS keyword "transparent" is rejected
      // by xterm's color parser; an 8-bit-alpha rgba is accepted and, with
      // allowTransparency, renders the canvas see-through.
      theme: { foreground, cursor, background: "rgba(0,0,0,0)" },
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
  }, [settingsVersion]);

  // Replay the active session's buffered output: on first mount (the
  // app-scope listener captured the shell banner before this component
  // existed), on every tab switch, and after a settings-driven rebuild
  // (the fresh instance starts empty — reset + buffer replay restores the
  // content preserved by the module-level buffers). term.reset() clears the
  // previous session; the buffer is the single source of truth.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term || !activeSessionId) return;
    term.reset();
    term.write(getReplay(activeSessionId));
  }, [activeSessionId, settingsVersion]);

  useEffect(() => {
    if (project && sessions.length === 0 && !loading && autoCreatedFor.current !== project.id) {
      autoCreatedFor.current = project.id;
      void create(project.path, terminalShell || undefined);
    }
  }, [project, sessions.length, loading, create, terminalShell]);

  const handleCreate = () => {
    // Empty shell = system default ("" -> undefined, the bridge's
    // Option<String> None).
    if (project) void create(project.path, terminalShell || undefined);
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
