import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Button, type ButtonProps } from "@glinui/ui";

interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost" | "accent";
  size?: "sm" | "md" | "lg";
}

// Map the project's button variants onto Glin UI's button variants.
const variantMap: Record<
  NonNullable<GlassButtonProps["variant"]>,
  NonNullable<ButtonProps["variant"]>
> = {
  default: "default",
  ghost: "ghost",
  accent: "glass",
};

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  ({ variant = "default", size = "md", className = "", children, ...props }, ref) => {
    return (
      <Button
        ref={ref as never}
        variant={variantMap[variant]}
        size={size}
        className={className}
        {...(props as object)}
      >
        {children}
      </Button>
    );
  }
);

GlassButton.displayName = "GlassButton";
