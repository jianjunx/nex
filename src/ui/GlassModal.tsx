import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { scaleIn } from "./animations";

interface GlassModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
}

export function GlassModal({ open, onClose, children, title }: GlassModalProps) {
  // Escape always closes — the modal must stay dismissible even while an
  // action inside it is still in flight.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

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
            className="relative z-10 w-full max-w-md rounded-[var(--radius-lg)] backdrop-blur-[12px] bg-[var(--glass-overlay-bg)] border border-[color:var(--border-emphasis)] p-6 glass-highlight"
          >
            <div className="flex items-center justify-between mb-4">
              {title ? (
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
              ) : (
                <span />
              )}
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-1 rounded-[var(--radius-sm)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--glass-interactive-bg)] transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
