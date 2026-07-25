import { forwardRef, type HTMLAttributes } from "react";

type GlassLevel = "base" | "elevated" | "interactive" | "overlay";

interface GlassProps extends HTMLAttributes<HTMLDivElement> {
  level?: GlassLevel;
  highlight?: boolean;
}

const levelStyles: Record<GlassLevel, string> = {
  base: "backdrop-blur-[40px] bg-[var(--glass-base-bg)]",
  elevated: "backdrop-blur-[24px] bg-[var(--glass-elevated-bg)] border border-[color:var(--border-default)]",
  interactive: "backdrop-blur-[16px] bg-[var(--glass-interactive-bg)] border border-[color:var(--border-strong)]",
  overlay: "backdrop-blur-[12px] bg-[var(--glass-overlay-bg)] border border-[color:var(--border-emphasis)]",
};

export const Glass = forwardRef<HTMLDivElement, GlassProps>(
  ({ level = "elevated", highlight = true, className = "", children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`rounded-[var(--radius-md)] ${levelStyles[level]} ${highlight ? "glass-highlight" : ""} ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Glass.displayName = "Glass";
