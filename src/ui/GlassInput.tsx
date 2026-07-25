import { forwardRef, type TextareaHTMLAttributes } from "react";
import { Textarea } from "@glinui/ui";

interface GlassInputProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  multiline?: boolean;
}

export const GlassInput = forwardRef<HTMLTextAreaElement, GlassInputProps>(
  ({ className = "", ...props }, ref) => {
    return (
      <Textarea
        ref={ref}
        variant="glass"
        rows={1}
        className={`resize-none ${className}`}
        {...(props as object)}
      />
    );
  }
);

GlassInput.displayName = "GlassInput";
