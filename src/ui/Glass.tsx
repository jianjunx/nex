import { forwardRef, type HTMLAttributes } from "react";
import { Card } from "@glinui/ui";

type GlassLevel = "base" | "elevated" | "interactive" | "overlay";

interface GlassProps extends HTMLAttributes<HTMLDivElement> {
  level?: GlassLevel;
  highlight?: boolean;
}

// Backed by Glin UI's Card. "overlay" gets the more opaque frosted variant.
const levelVariant: Record<GlassLevel, "glass" | "frosted"> = {
  base: "glass",
  elevated: "glass",
  interactive: "glass",
  overlay: "frosted",
};

export const Glass = forwardRef<HTMLDivElement, GlassProps>(
  ({ level = "elevated", highlight = true, className = "", children, ...props }, ref) => {
    return (
      <Card
        ref={ref as never}
        variant={levelVariant[level]}
        className={`${highlight ? "glass-highlight" : ""} ${className}`}
        {...(props as object)}
      >
        {children}
      </Card>
    );
  }
);

Glass.displayName = "Glass";
