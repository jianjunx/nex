import { forwardRef, type TextareaHTMLAttributes } from "react";

interface GlassInputProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  multiline?: boolean;
}

export const GlassInput = forwardRef<HTMLTextAreaElement, GlassInputProps>(
  ({ className = "", ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={`w-full resize-none rounded-[var(--radius-lg)] bg-[var(--glass-interactive-bg)] border border-[color:var(--border-strong)] px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[color:var(--border-focus)] focus:shadow-[var(--shadow-focus)] transition-all duration-200 ${className}`}
        rows={1}
        {...props}
      />
    );
  }
);

GlassInput.displayName = "GlassInput";
