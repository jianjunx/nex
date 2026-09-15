"use client";

import {
  useRef,
  useState,
  type FocusEvent,
  type HTMLAttributes,
  type MouseEvent,
} from "react";

export type GlideMenuProps = HTMLAttributes<HTMLDivElement> & {
  rowSelector?: string;
  highlightClassName?: string;
};

export default function GlideMenu({
  rowSelector = "[data-menu-row]",
  highlightClassName = "inset-x-0 rounded-[8px] bg-hover",
  className = "",
  children,
  ...props
}: GlideMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<{
    top: number;
    height: number;
  } | null>(null);
  const [visible, setVisible] = useState(false);

  const place = (target: EventTarget | null) => {
    const root = rootRef.current;
    if (!(target instanceof Element) || !root) return;
    const row = target.closest(rowSelector);
    if (!(row instanceof HTMLElement) || !root.contains(row)) return;
    const rootBounds = root.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    setHighlight({
      top: rowBounds.top - rootBounds.top,
      height: rowBounds.height,
    });
    setVisible(true);
  };

  const handleMouseOver = (event: MouseEvent<HTMLDivElement>) =>
    place(event.target);
  const handleFocus = (event: FocusEvent<HTMLDivElement>) =>
    place(event.target as Element);
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!rootRef.current?.contains(event.relatedTarget)) setVisible(false);
  };

  return (
    <div
      ref={rootRef}
      className={`group/glide-menu relative ${className}`}
      onMouseOver={handleMouseOver}
      onMouseLeave={() => setVisible(false)}
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
      {...props}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute ${highlightClassName}`}
        style={{
          top: highlight?.top ?? 0,
          height: highlight?.height ?? 0,
          opacity: highlight && visible ? 1 : 0,
          transition:
            "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease",
        }}
      />
      {children}
    </div>
  );
}
