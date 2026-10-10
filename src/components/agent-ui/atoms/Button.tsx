"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant =
  "primary" | "secondary" | "accent" | "success" | "ghost" | "quiet";

export type ButtonSize = "xs" | "sm" | "md";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-ink text-canvas hover:opacity-90 dark:bg-ink dark:text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]",
  secondary:
    "bg-surface text-ink shadow-btn hover:bg-inset aria-expanded:bg-hover",
  ghost: "bg-hover-2 text-ink hover:bg-line-strong",
  accent:
    "bg-accent text-white hover:bg-accent-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]",
  success:
    "bg-green text-white hover:brightness-95 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]",
  quiet: "text-ink hover:bg-hover",
};

const sizes: Record<ButtonSize, string> = {
  xs: "h-7 rounded-full px-2.5 text-[12px] font-normal leading-none gap-1",
  sm: "h-[27px] rounded-full px-3 text-[13px] leading-none gap-1.5",
  md: "rounded-full px-4 py-[9px] text-sm leading-none gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      className = "",
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={`inline-flex items-center justify-center select-none font-medium transition-[transform,background-color,opacity] duration-150 ease-out active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 ${sizes[size]} ${variants[variant]} ${className}`}
        {...props}
      />
    );
  },
);
