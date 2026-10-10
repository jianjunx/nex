import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { Collapse } from "@/components/ui/Collapse";
import { easeScrollTop, isEaseFollow } from "./easeScrollTop";
import { Markdown } from "./Markdown";
import { StreamingProse } from "./StreamingProse";

/** Live reasoning trace using Beautiful UI's compact disclosure and inset rail. */
export function ThinkingBlock({
  text,
  defaultOpen = false,
  streaming = false,
}: {
  text: string;
  defaultOpen?: boolean;
  /** 这段思考仍在生成。停掉之后把还没吐出的词加快补完。 */
  streaming?: boolean;
}) {
  // Follow `defaultOpen` (live reasoning shows itself, then folds when the
  // turn moves on) until the user toggles it explicitly.
  const [override, setOverride] = useState<boolean | null>(null);
  // 停流时若直接换成全文，没吐完的半截会一下子跳齐。留下吐字组件把尾巴补完，
  // 补完前先保持展开，避免和 defaultOpen 同时收起把收尾挡住。
  const [live, setLive] = useState(streaming);
  const open = override ?? (defaultOpen || live);
  useEffect(() => {
    if (streaming) setLive(true);
  }, [streaming]);
  const settle = useCallback(() => setLive(false), []);
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const el = body.current;
    if (!open || !el) return;
    if (following.current) easeScrollTop(el, el.scrollHeight);
    const inner = el.firstElementChild;
    if (!inner || typeof ResizeObserver === "undefined") return;
    // 逐词吐字时外层 text 不变，内容仍在长高，跟着滚到底。
    const observer = new ResizeObserver(() => {
      if (following.current) easeScrollTop(el, el.scrollHeight);
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [text, open, streaming]);
  return (
    <div className="beautiful-ui nex-reasoning">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        className="nex-trace-toggle"
        onClick={() => setOverride(!open)}
      >
        <Sparkles size={15} />
        <span>思考过程</span>
        <ChevronDown size={13} className={open ? "rotate-180" : ""} />
      </button>
      <Collapse open={open} id={id}>
        <div
          className="nex-trace-body"
          ref={body}
          onScroll={() => {
            const el = body.current;
            if (!el || isEaseFollow(el)) return;
            following.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {live ? (
            <StreamingProse text={text} active={streaming} compact muted onIdle={settle} />
          ) : (
            <Markdown compact muted>
              {text}
            </Markdown>
          )}
        </div>
      </Collapse>
    </div>
  );
}
