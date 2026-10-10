import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { usePresence } from "./usePresence";

/**
 * Height disclosure. `grid-template-rows` animates `0fr` ↔ `1fr`.
 * Closed content unmounts after the transition so heavy trees do not stay resident.
 */
export function Collapse({
  open,
  children,
  className,
  id,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const { ref, mounted, shown } = usePresence(open);
  if (!mounted) return null;
  return (
    <div
      ref={ref}
      id={id}
      className={cn("nex-collapse", className)}
      data-open={shown ? "true" : "false"}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
    >
      <div className="nex-collapse-inner">{children}</div>
    </div>
  );
}
