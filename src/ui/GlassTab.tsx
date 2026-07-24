import { motion } from "framer-motion";

interface GlassTabProps {
  label: string;
  active: boolean;
  indicator?: "running" | "idle" | "waiting" | null;
  onClick: () => void;
  onClose?: () => void;
}

export function GlassTab({ label, active, indicator, onClick, onClose }: GlassTabProps) {
  const indicatorColor = indicator === "running" ? "var(--accent)" : indicator === "waiting" ? "var(--warning)" : "transparent";

  return (
    <motion.div
      layoutId={`tab-${label}`}
      onClick={onClick}
      className={`relative flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-sm)] cursor-pointer text-sm transition-colors ${
        active ? "bg-[var(--glass-interactive-bg)] text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      }`}
    >
      {indicator && indicator !== "idle" && (
        <motion.span
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: indicatorColor }}
          animate={indicator === "running" ? { scale: [1, 1.3, 1] } : {}}
          transition={{ repeat: Infinity, duration: 1.5 }}
        />
      )}
      <span className="max-w-[120px] truncate">{label}</span>
      {onClose && (
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="ml-1 opacity-50 hover:opacity-100 text-xs"
        >
          ×
        </button>
      )}
      {active && (
        <motion.div
          layoutId="tab-underline"
          className="absolute bottom-0 left-2 right-2 h-[2px] bg-[var(--accent)] rounded-full"
        />
      )}
    </motion.div>
  );
}
