import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UserMessageImage } from "./types";

/** Chat-bubble image: mid-size thumbnail; click opens a lightbox preview. */
export function ThreadImageThumb({ image }: { image: UserMessageImage }) {
  const [open, setOpen] = useState(false);
  const src = `data:${image.mimeType};base64,${image.data}`;

  return (
    <>
      <button
        type="button"
        title="预览图片"
        className="block shrink-0 rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <img src={src} alt="" className="h-24 w-24 object-cover" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-[min(92vw,900px)] p-2 border-[color:var(--glass-border)] bg-[var(--glass-3-surface)]"
          showCloseButton
        >
          <DialogTitle className="sr-only">图片预览</DialogTitle>
          <img
            src={src}
            alt=""
            className="max-h-[80vh] w-full object-contain rounded-[var(--radius-sm)]"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
