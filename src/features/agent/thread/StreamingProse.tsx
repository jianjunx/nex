import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import {
  STREAM_WORD_MS,
  revealWords,
  wordsBehind,
  wordsThisTick,
} from "./streamingReveal";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 按 beautiful-ui Streaming Text 的方式吐字：每 55ms 出一个完整的词，
 * 已揭示的部分整段走 Markdown（不把句尾拆到另一层），光标贴在最后一段末尾。
 * 挂载时已经到达的文字直接显示，只对之后新到的词做动画。
 */
export function StreamingProse({
  text,
  active,
  compact = false,
  muted = false,
  onIdle,
}: {
  text: string;
  active: boolean;
  /** 思考过程用更紧的字号。 */
  compact?: boolean;
  /** 思考过程用次级文字色。 */
  muted?: boolean;
  /** 生成已结束且文字已经全部显示。 */
  onIdle?: () => void;
}) {
  const reduce = useRef(prefersReducedMotion());
  const shownRef = useRef(reduce.current ? text.length : text.length);
  const [shown, setShown] = useState(shownRef.current);
  const textRef = useRef(text);
  const activeRef = useRef(active);
  const onIdleRef = useRef(onIdle);
  textRef.current = text;
  activeRef.current = active;
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (reduce.current) return;
    const timer = window.setInterval(() => {
      const source = textRef.current;
      if (shownRef.current > source.length) shownRef.current = source.length;
      const behind = wordsBehind(source, shownRef.current);
      if (behind === 0) return;
      const next = revealWords(
        source,
        shownRef.current,
        wordsThisTick(behind, !activeRef.current),
      );
      if (next === shownRef.current) return;
      shownRef.current = next;
      setShown(next);
    }, STREAM_WORD_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (active) return;
    if (reduce.current || shown >= text.length) onIdleRef.current?.();
  }, [active, shown, text]);

  if (reduce.current || (!active && shown >= text.length)) {
    return (
      <Markdown compact={compact} muted={muted}>
        {text}
      </Markdown>
    );
  }

  const visible = text.slice(0, Math.min(shown, text.length));
  const streaming = active || shown < text.length;
  return (
    <div className={streaming ? "nex-stream-live is-active" : "nex-stream-live"}>
      {visible ? (
        <Markdown compact={compact} muted={muted}>
          {visible}
        </Markdown>
      ) : null}
    </div>
  );
}
