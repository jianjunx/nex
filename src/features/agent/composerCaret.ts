/**
 * Approximate caret (selection end) coordinates relative to a textarea,
 * for positioning suggest popovers. Mirror-div technique — no layout thrash
 * beyond one measurement per open/keystroke when the menu is visible.
 */

export type CaretPoint = { top: number; left: number; lineHeight: number };

export function measureCaretInTextarea(
  el: HTMLTextAreaElement,
  position = el.selectionEnd,
): CaretPoint | null {
  const style = window.getComputedStyle(el);
  const mirror = document.createElement("div");
  const props = [
    "boxSizing",
    "width",
    "height",
    "overflowX",
    "overflowY",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "fontStretch",
    "fontSize",
    "fontSizeAdjust",
    "lineHeight",
    "fontFamily",
    "textAlign",
    "textTransform",
    "textIndent",
    "textDecoration",
    "letterSpacing",
    "wordSpacing",
    "tabSize",
    "whiteSpace",
    "wordWrap",
    "wordBreak",
  ] as const;
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  for (const p of props) {
    mirror.style.setProperty(
      p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
      style.getPropertyValue(p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)) ||
        (style as unknown as Record<string, string>)[p],
    );
  }
  // Prefer copying computed values directly for reliability.
  mirror.style.width = style.width;
  mirror.style.font = style.font;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.padding = style.padding;
  mirror.style.border = style.border;
  mirror.style.boxSizing = style.boxSizing;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflow = "hidden";

  const before = el.value.slice(0, position);
  mirror.textContent = before;
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2 || 18;

  const top = markerRect.top - mirrorRect.top - el.scrollTop + elRect.top;
  const left = markerRect.left - mirrorRect.left - el.scrollLeft + elRect.left;

  document.body.removeChild(mirror);
  return { top, left, lineHeight };
}
