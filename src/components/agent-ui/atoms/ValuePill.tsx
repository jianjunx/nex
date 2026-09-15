import type { ReactNode } from "react";

export type ValuePillTone = "neutral" | "green" | "orange" | "red" | "accent";

export type ValuePillProps = {
  children: ReactNode;
  tone?: ValuePillTone;
  className?: string;
};

const tones: Record<ValuePillTone, { className: string; ring: string }> = {
  neutral: { className: "bg-field text-ink-2", ring: "var(--shadow-hairline)" },
  green: {
    className: "bg-green-tint text-green",
    ring: "0 0 0 1px color-mix(in oklch, var(--green) 28%, transparent)",
  },
  orange: {
    className: "bg-orange-tint text-orange",
    ring: "0 0 0 1px color-mix(in oklch, var(--orange) 28%, transparent)",
  },
  red: {
    className: "bg-red-tint text-red",
    ring: "0 0 0 1px color-mix(in oklch, var(--red) 28%, transparent)",
  },
  accent: {
    className: "bg-accent-tint text-accent-ink",
    ring: "0 0 0 1px color-mix(in oklch, var(--accent) 28%, transparent)",
  },
};

export function ValuePill({
  children,
  tone = "neutral",
  className = "",
}: ValuePillProps) {
  const resolved = tones[tone];
  return (
    <span
      className={`mx-0.5 inline-flex items-center rounded-full px-1.5 py-0 align-middle text-[12px] font-medium ${resolved.className} ${className}`}
      style={{ boxShadow: resolved.ring }}
    >
      {children}
    </span>
  );
}
