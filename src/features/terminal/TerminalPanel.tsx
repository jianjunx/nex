import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Plus, X } from "lucide-react";
import { useTerminalStore } from "../../stores/terminal.store";
import { useProjectStore } from "../../stores/project.store";
import { onTerminalOutput } from "../../bridge/tauri";
import { GlassButton } from "../../ui";

export function TerminalPanel() {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const { sessions, activeSessionId, create, write, resize, kill, setActive } = useTerminalStore();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "JetBrains Mono, Menlo, monospace",
      theme: {
        background: "transparent",
        foreground: "rgba(255,255,255,0.9)",
        cursor: "rgba(255,255,255,0.7)",
      },
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    term.onData((data) => {
      if (activeSessionId) write(activeSessionId, data);
    });

    term.onResize(({ cols, rows }) => {
      if (activeSessionId) resize(activeSessionId, cols, rows);
    });

    xtermRef.current = term;

    const unlisten = onTerminalOutput(({ terminalId, data }) => {
      if (terminalId === activeSessionId) term.write(data);
    });

    return () => { unlisten.then((fn) => fn()); term.dispose(); };
  }, [activeSessionId]);

  const handleCreate = () => {
    if (project) void create(project.path);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-white/[0.06]">
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => setActive(s.id)}
            className={`px-2 py-0.5 text-xs rounded ${s.id === activeSessionId ? "bg-white/[0.1]" : ""}`}
          >
            {s.title}
          </button>
        ))}
        <GlassButton size="sm" variant="ghost" onClick={handleCreate}><Plus size={12} /></GlassButton>
        {activeSessionId && (
          <GlassButton size="sm" variant="ghost" onClick={() => void kill(activeSessionId)}><X size={12} /></GlassButton>
        )}
      </div>
      <div ref={termRef} className="flex-1 p-1" />
    </div>
  );
}
