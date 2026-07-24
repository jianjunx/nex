import { forwardRef, type TextareaHTMLAttributes } from "react";

interface GlassInputProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  multiline?: boolean;
}

export const GlassInput = forwardRef<HTMLTextAreaElement, GlassInputProps>(
  ({ className = "", ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={`w-full resize-none rounded-[var(--radius-lg)] bg-[var(--glass-interactive-bg)] border border-white/[0.12] px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-white/[0.20] focus:shadow-[0_0_20px_rgba(255,255,255,0.05)] transition-all duration-200 ${className}`}
        rows={1}
        {...props}
      />
    );
  }
);

GlassInput.displayName = "GlassInput";
