import { useRef, useState } from "react";
import { errorMessage } from "@/lib/errors";
import { toast } from "@/stores/toast.store";

/** Keep async selections visible until the operation finishes. */
export function usePendingOption(
  onSelect: (id: string) => void | Promise<void>,
  onOpenChange?: (open: boolean) => void,
  failureMessage = "切换失败",
) {
  const [open, updateOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const running = useRef(false);
  const setOpen = (next: boolean) => {
    updateOpen(next);
    onOpenChange?.(next);
  };
  const select = async (id: string) => {
    if (running.current) return;
    running.current = true;
    setPendingId(id);
    try {
      await onSelect(id);
      setOpen(false);
    } catch (err) {
      toast({ variant: "error", message: failureMessage, detail: errorMessage(err) });
    } finally {
      running.current = false;
      setPendingId(null);
    }
  };
  return { open, setOpen, pendingId, select };
}
