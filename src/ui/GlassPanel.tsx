import { type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { springTransition } from "./animations";

interface GlassPanelProps {
  children: ReactNode;
  visible: boolean;
  width?: number;
  side?: "left" | "right";
  className?: string;
}

export function GlassPanel({ children, visible, width = 320, side: _side = "right", className = "" }: GlassPanelProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={springTransition}
          className={`h-full overflow-hidden border-l border-white/[0.06] ${className}`}
          style={{ width }}
        >
          <div className="h-full w-full backdrop-blur-[24px] bg-[var(--glass-elevated-bg)] overflow-y-auto">
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
