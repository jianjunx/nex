import { Component, useEffect, useId, useState, type ReactNode } from "react";
import mermaid from "mermaid";
import { useSettingsStore } from "../../../stores/settings.store";
import { mermaidConfigFor } from "./mermaidTheme";

interface MermaidBlockProps {
  code: string;
}

/** Error boundary so a synchronous throw in the Mermaid renderer falls back
 *  to the raw fenced text rather than crashing the whole chat bubble. */
class MermaidErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    // Swallowed — fallback UI is rendered below.
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const theme = useSettingsStore((s) => s.theme);
  // `useId` may contain colons (e.g. `:r0:`) which break the CSS selector
  // Mermaid uses internally to inject the rendered SVG.
  const idBase = useId().replace(/:/g, "_");
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setErr(null);
    mermaid.initialize(mermaidConfigFor(theme));
    mermaid
      .render(`mmd-${idBase}`, code)
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [code, idBase, theme]);

  if (err) {
    // Mermaid couldn't parse the source — fall back to the raw fenced code
    // so the user can still read / copy it. Same `<pre><code>` styling as a
    // regular fenced block.
    return (
      <pre className="overflow-x-auto rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-3-surface)] p-2.5 text-xs">
        <code>{code}</code>
      </pre>
    );
  }

  if (!svg) {
    return (
      <div className="my-2 rounded-[var(--radius-md)] border border-dashed border-[color:var(--border-subtle)] bg-[var(--glass-3-surface)] px-3 py-2 text-xs text-[var(--text-tertiary)]">
        Rendering diagram…
      </div>
    );
  }

  return (
    <MermaidErrorBoundary fallback={<RawFencedCode code={code} />}>
      <div
        className="my-2 flex justify-center overflow-x-auto rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-3-surface)] p-3"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </MermaidErrorBoundary>
  );
}

function RawFencedCode({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-3-surface)] p-2.5 text-xs">
      <code>{code}</code>
    </pre>
  );
}