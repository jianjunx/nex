import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import {
  STREAM_BLUR_CHARS,
  STREAM_SETTLE_DONE_MS,
  STREAM_SETTLE_MS,
  advanceReveal,
  seedReveal,
  splitStream,
} from "./streamingReveal";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 把已经到达的正文按匀速揭示出来。网络分片是突发的，这里把它摊成
 * beautiful-ui 那种连续吐字：稳定部分走 Markdown，末尾几个字模糊淡出，并跟一个光标。
 * 挂载时从当前末尾开始，不把已经到达的段落重播一遍。
 */
export function StreamingProse({ text, active }: { text: string; active: boolean }) {
  const reduce = useRef(prefersReducedMotion());
  const shownRef = useRef(reduce.current ? text.length : seedReveal(text.length));
  const [shown, setShown] = useState(shownRef.current);
  const textRef = useRef(text);
  const activeRef = useRef(active);
  textRef.current = text;
  activeRef.current = active;

  useEffect(() => {
    if (reduce.current) {
      shownRef.current = text.length;
      setShown(text.length);
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      const target = textRef.current.length;
      if (shownRef.current > target) shownRef.current = seedReveal(target);
      const settle = activeRef.current ? STREAM_SETTLE_MS : STREAM_SETTLE_DONE_MS;
      const next = advanceReveal(shownRef.current, target, dt, settle);
      if (Math.floor(next) !== Math.floor(shownRef.current)) setShown(Math.floor(next));
      shownRef.current = next;
      if (next < target) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, active]);

  const caughtUp = shown >= text.length;
  if (!active && caughtUp) return <Markdown>{text}</Markdown>;

  const { markdown, tail, code } = splitStream(text, shown);
  const blurAt = Math.max(0, tail.length - STREAM_BLUR_CHARS);
  const fenceBody = code ? tail.replace(/^```[^\n]*\n?/, "") : tail;

  return (
    <div className={`nex-stream-live${active ? " is-active" : ""}`}>
      {markdown ? <Markdown>{markdown}</Markdown> : null}
      {code ? (
        <pre className="overflow-x-auto rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--material-floating)] px-3 py-2.5 font-mono text-xs leading-relaxed">
          <code>
            {fenceBody.slice(0, blurAt)}
            {blurAt < fenceBody.length ? (
              <span className="stream-tail">{fenceBody.slice(blurAt)}</span>
            ) : null}
          </code>
        </pre>
      ) : tail ? (
        <span className="whitespace-pre-wrap">
          {tail.slice(0, blurAt)}
          {blurAt < tail.length ? <span className="stream-tail">{tail.slice(blurAt)}</span> : null}
        </span>
      ) : null}
      <span aria-hidden className="stream-caret is-streaming" />
    </div>
  );
}
