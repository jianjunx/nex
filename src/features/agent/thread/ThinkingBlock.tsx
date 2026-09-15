import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { Markdown } from "./Markdown";

/** Live reasoning trace using Beautiful UI's compact disclosure and inset rail. */
export function ThinkingBlock({
  text,
  defaultOpen = false,
}: {
  text: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (open && following.current && body.current)
      body.current.scrollTop = body.current.scrollHeight;
  }, [text, open]);
  return (
    <div className="beautiful-ui nex-reasoning">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        className="nex-trace-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <Sparkles size={15} />
        <span>思考过程</span>
        <ChevronDown size={13} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <div
          id={id}
          className="nex-trace-body"
          ref={body}
          onScroll={() => {
            const el = body.current;
            if (el)
              following.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          <Markdown compact muted>
            {text}
          </Markdown>
        </div>
      )}
    </div>
  );
}
