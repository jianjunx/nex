"use client";

import { useEffect, useRef, useState } from "react";

export type StreamTextProps = {
  text: string;
  charsPerTick?: number;
  tickMs?: number;
  blurTail?: number;
  caret?: boolean;
  className?: string;
  onProgress?: () => void;
  onDone?: () => void;
};

export function StreamText({
  text,
  charsPerTick = 2,
  tickMs = 9,
  blurTail = 6,
  caret = true,
  className,
  onProgress,
  onDone,
}: StreamTextProps) {
  const [count, setCount] = useState(0);
  const progressRef = useRef(onProgress);
  const doneRef = useRef(onDone);

  progressRef.current = onProgress;
  doneRef.current = onDone;

  useEffect(() => {
    setCount(0);
    let next = 0;
    const timer = window.setInterval(() => {
      next = Math.min(next + charsPerTick, text.length);
      setCount(next);
      progressRef.current?.();
      if (next >= text.length) {
        window.clearInterval(timer);
        doneRef.current?.();
      }
    }, tickMs);
    return () => window.clearInterval(timer);
  }, [text, charsPerTick, tickMs]);

  const streaming = count < text.length;
  const visible = text.slice(0, count);
  const tailStart = streaming
    ? Math.max(0, visible.length - blurTail)
    : visible.length;

  return (
    <span className={className}>
      {visible.slice(0, tailStart)}
      {tailStart < visible.length && (
        <span className="stream-tail">{visible.slice(tailStart)}</span>
      )}
      {caret && (
        <span
          aria-hidden
          className={`stream-caret${streaming ? " is-streaming" : ""}`}
        />
      )}
    </span>
  );
}
