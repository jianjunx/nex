import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Plus, X } from "lucide-react";
import {
  useTerminalStore,
  getReplay,
  setLiveSink,
  selectProjectSessions,
  selectProjectActiveSessionId,
} from "../../stores/terminal.store";
import { useSettingsStore } from "../../stores/settings.store";
import { useProjectStore } from "../../stores/project.store";
import { useUiStore } from "../../stores/ui.store";
import { Button } from "@/components/ui/button";
import { registerModWebLinks } from "./modWebLinks";

export function TerminalPanel() {
  const termRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const allSessions = useTerminalStore((s) => s.sessions);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const visibleSessionId = useTerminalStore((s) => selectProjectActiveSessionId(s, activeProjectId));
  const loading = useTerminalStore((s) => s.loading);
  const error = useTerminalStore((s) => s.error);
  const create = useTerminalStore((s) => s.create);
  const kill = useTerminalStore((s) => s.kill);
  const setActive = useTerminalStore((s) => s.setActive);
  const focusProject = useTerminalStore((s) => s.focusProject);
  const clearError = useTerminalStore((s) => s.clearError);
  const settingsVersion = useTerminalStore((s) => s.settingsVersion);
  const terminalShell = useSettingsStore((s) => s.terminalShell);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === activeProjectId);
  const sessions = selectProjectSessions(allSessions, activeProjectId);

  // Open = usable: the tray mounts only when the terminal is toggled visible
  // (SidePanel gates it on terminalVisible), so creating a session on mount
  // makes "open the terminal" immediately yield a live shell instead of an
  // empty black box that waits for a manual "+". A manual kill of the last
  // session does NOT respawn (this effect won't re-run); reopening the tray
  // remounts and respawns, which matches "open = usable".
  const autoCreatedFor = useRef<string | null>(null);

  // When the active project changes, show that project's PTY tabs without
  // killing other projects' sessions (buffers + liveSink keep them warm).
  useEffect(() => {
    focusProject(activeProjectId);
  }, [activeProjectId, focusProject]);

  // Construct the single xterm instance; session switches reuse it via
  // reset + replay (effect below) instead of dispose/reconstruct.
  // Rebuilt when settingsVersion bumps (settings.store setters) — the
  // module-level output buffers survive the dispose, and the replay effect
  // below restores the visible content.
  useEffect(() => {
    if (!termRef.current) return;

    // Terminal foreground/cursor follow the active theme so text stays
    // readable on both light and dark app backgrounds.
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
      // Transparent background so the app surface underneath shows through.
      // NOTE: OMITTING the background key does NOT give transparency — xterm
      // then paints its default OPAQUE black, which on the light theme hides
      // the dark foreground (black-on-black). The CSS keyword "transparent"
      // is rejected by xterm's color parser; an 8-bit-alpha rgba is accepted
      // and, with allowTransparency, renders the canvas see-through.
      theme: { foreground, cursor, background: "rgba(0,0,0,0)" },
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();
    term.focus();

    const disposeWebLinks = registerModWebLinks(term);

    // Read the session at call time via getState() — never capture
    // activeSessionId/write/resize from render scope (stale closures).
    term.onData((data) => {
      const state = useTerminalStore.getState();
      const projectId = useProjectStore.getState().activeProjectId;
      const sessionId = selectProjectActiveSessionId(state, projectId);
      if (sessionId) state.write(sessionId, data);
    });
    term.onResize(({ cols, rows }) => {
      const state = useTerminalStore.getState();
      const projectId = useProjectStore.getState().activeProjectId;
      const sessionId = selectProjectActiveSessionId(state, projectId);
      if (sessionId) state.resize(sessionId, cols, rows);
    });

    // Paste via the paste event's clipboardData (user-gesture, no permission
    // chip). Capture + stopImmediatePropagation so we own the event and xterm
    // does not also paste. Avoid navigator.clipboard.readText() — on macOS
    // WKWebView that surfaces a "Paste" button and blocks until clicked.
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain") || e.clipboardData?.getData("text");
      if (text == null || text === "") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      term.paste(text);
    };
    term.textarea?.addEventListener("paste", onPaste, true);

    xtermRef.current = term;

    // Render live output for the ACTIVE session immediately; background
    // tabs buffer only (their replay runs on switch). getState() at call
    // time — never capture activeSessionId.
    setLiveSink((id, data) => {
      const state = useTerminalStore.getState();
      const pid = useProjectStore.getState().activeProjectId;
      const visibleId = selectProjectActiveSessionId(state, pid);
      if (visibleId !== id) return;
      // Ignore stray output if the active session no longer matches the
      // project this panel instance was keyed for (belt-and-suspenders with
      // key={activeProjectId} remounts).
      const session = state.sessions.find((s) => s.id === id);
      if (session && pid && session.projectId !== pid) return;
      term.write(data);
    });

    const el = termRef.current;
    // Debounced fit: while dragging the panel divider the observer fires
    // every frame, and each fit() reflows xterm + sends a PTY resize IPC.
    // Coalescing to a trailing ~66ms keeps the final size exact without
    // reflowing on every pointermove.
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return;
      if (fitTimer !== undefined) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        fitTimer = undefined;
        fitAddon.fit();
      }, 66);
    });
    observer.observe(el);
    // Initial fit without debounce so the first paint is correct.
    if (el.offsetWidth > 0 && el.offsetHeight > 0) fitAddon.fit();

    return () => {
      if (fitTimer !== undefined) clearTimeout(fitTimer);
      disposeWebLinks();
      term.textarea?.removeEventListener("paste", onPaste, true);
      setLiveSink(null); observer.disconnect(); term.dispose(); xtermRef.current = null;
    };
    // settingsVersion only: panel remounts per project via key={activeProjectId};
    // liveSink reads project id via getState() so it must not rebuild xterm on switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [settingsVersion]);

  // Replay the active session's buffered output: on first mount (the
  // app-scope listener captured the shell banner before this component
  // existed), on every tab switch, and after a settings-driven rebuild
  // (the fresh instance starts empty — reset + buffer replay restores the
  // content preserved by the module-level buffers). term.reset() clears the
  // previous session; the buffer is the single source of truth.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.reset();
    if (!visibleSessionId) return;
    term.write(getReplay(visibleSessionId));
    // Fit after the session is active so onResize can push cols/rows to the
    // PTY (the mount-time fit often ran with no activeSessionId).
    try {
      const { cols, rows } = term;
      if (cols > 0 && rows > 0) {
        useTerminalStore.getState().resize(visibleSessionId, cols, rows);
      }
    } catch {
      /* ignore */
    }
    term.focus();
  }, [visibleSessionId, settingsVersion]);

  useEffect(() => {
    if (!project) return;
    // Already have sessions for this project — just show them (focusProject).
    if (sessions.length > 0) {
      autoCreatedFor.current = project.id;
      return;
    }
    if (loading || autoCreatedFor.current === project.id) return;
    autoCreatedFor.current = project.id;
    const term = xtermRef.current;
    void create(project.id, project.path, terminalShell || undefined, term?.cols, term?.rows);
  }, [project, sessions.length, loading, create, terminalShell]);

  const handleCreate = () => {
    // Empty shell = system default ("" -> undefined, the bridge's
    // Option<String> None).
    if (project) {
      const term = xtermRef.current;
      void create(project.id, project.path, terminalShell || undefined, term?.cols, term?.rows);
    }
  };

  const handleClose = (id: string) => {
    const projectSessions = selectProjectSessions(
      useTerminalStore.getState().sessions,
      activeProjectId,
    );
    const isLastForProject = projectSessions.length <= 1;
    void kill(id).then(() => {
      if (isLastForProject) useUiStore.getState().setTerminalVisible(false);
    });
  };

  const focusTerminal = () => {
    xtermRef.current?.focus();
  };

  return (
    <div className="flex flex-col h-full">
      <div className="nex-material-toolbar flex items-center gap-1.5 border-b border-[color:var(--hairline-soft)] px-3 py-1">
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setActive(s.id)}
            className={`nex-interactive-chrome flex items-center gap-1.5 px-2.5 py-0.5 text-xs rounded-[var(--radius-md)] border ${s.id === visibleSessionId ? "border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--material-elevated)_80%,transparent)] text-[var(--text-primary)] shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)]" : "border-transparent text-[var(--text-tertiary)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_72%,transparent)] hover:text-[var(--text-secondary)]"}`}
          >
            <span className="truncate max-w-[120px]">{s.title}</span>
            <span
              role="button"
              title="关闭终端"
              className="nex-interactive-chrome rounded-[var(--radius-sm)] p-0.5 opacity-50 hover:bg-[var(--overlay-hover)] hover:opacity-100"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                handleClose(s.id);
              }}
            >
              <X size={11} />
            </span>
          </button>
        ))}
        <Button size="icon-xs" variant="ghost" disabled={!project} onClick={handleCreate} title="新建终端" className="nex-interactive-chrome nex-pressable rounded-[var(--radius-md)] border border-transparent hover:border-[color:var(--hairline-soft)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_72%,transparent)]">
          <Plus size={12} />
        </Button>
      </div>
      {error && (
        <div className="flex items-center gap-2 bg-[var(--error)]/10 px-4 py-1.5 text-xs text-[var(--error)]">
          <span className="flex-1 truncate">{error}</span>
          <Button size="sm" variant="ghost" onClick={clearError}><X size={12} /></Button>
        </div>
      )}
      {/* The xterm host stays mounted for the tray's whole lifetime —
          construction is a mount-once effect, so unmounting the host while
          no project is open would leave a dead terminal when one is opened
          later (the effect never re-runs). The empty state overlays it. */}
      {/* p-2：终端内容区四周留 8px 内边距。内层尺寸变化由 ResizeObserver
          捕获，debounced fit 会重算 cols/rows 并同步 PTY。 */}
      <div
        ref={hostRef}
        data-terminal-host
        className="relative flex-1 overflow-hidden min-h-0 p-2"
        onMouseDown={focusTerminal}
      >
        <div ref={termRef} className="h-full w-full" />
        {!project && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-tertiary)]">
            未打开项目
          </div>
        )}
      </div>
    </div>
  );
}
