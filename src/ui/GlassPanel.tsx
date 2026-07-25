import { type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { springTransition } from "./animations";
import { Card } from "@glinui/ui";

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
          className={`h-full overflow-hidden ${className}`}
          style={{ width }}
        >
          <Card variant="glass" className="h-full w-full overflow-y-auto">
            {children}
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
