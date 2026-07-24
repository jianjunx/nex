import { forwardRef, type ButtonHTMLAttributes } from "react";
import { motion } from "framer-motion";
import { springTransition } from "./animations";

interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost" | "accent";
  size?: "sm" | "md" | "lg";
}

const sizes = {
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
  lg: "px-4 py-2 text-base",
};

const variants = {
  default: "bg-[var(--glass-interactive-bg)] border border-white/[0.12] hover:bg-white/[0.13]",
  ghost: "bg-transparent border border-transparent hover:bg-white/[0.06]",
  accent: "bg-[var(--accent)] border border-transparent hover:bg-[var(--accent-hover)]",
};

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  ({ variant = "default", size = "md", className = "", children, ...props }, ref) => {
    return (
      <motion.button
        ref={ref as any}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.97 }}
        transition={springTransition}
        className={`rounded-[var(--radius-sm)] font-medium cursor-pointer transition-colors duration-150 ${sizes[size]} ${variants[variant]} ${className}`}
        {...(props as any)}
      >
        {children}
      </motion.button>
    );
  }
);

GlassButton.displayName = "GlassButton";
