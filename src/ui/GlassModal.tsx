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
          <div className="absolute inset-0 backdrop-blur-[20px] bg-[var(--glass-base-bg)]" onClick={onClose} />
          <motion.div
            {...scaleIn}
            className="relative z-10 w-full max-w-md rounded-[var(--radius-xl)] backdrop-blur-[40px] bg-[var(--glass-elevated-bg)] border border-[color:var(--border-emphasis)] p-8 shadow-2xl glass-highlight"
          >
            <div className="flex items-center justify-between mb-6 -mt-1 -mx-1">
              {title ? (
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
              ) : (
                <span />
              )}
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-2 rounded-[var(--radius-sm)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--glass-interactive-bg)] transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="px-1">
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
