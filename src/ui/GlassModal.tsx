import { type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { scaleIn } from "./animations";

interface GlassModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
}

export function GlassModal({ open, onClose, children, title }: GlassModalProps) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/40" onClick={onClose} />
          <motion.div
            {...scaleIn}
            className="relative z-10 w-full max-w-md rounded-[var(--radius-lg)] backdrop-blur-[12px] bg-[var(--glass-overlay-bg)] border border-white/[0.18] p-6 glass-highlight"
          >
            {title && (
              <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">{title}</h2>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
