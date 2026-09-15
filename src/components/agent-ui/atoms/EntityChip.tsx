import type { ReactNode } from "react";

export type EntityChipProps = {
  name: string;
  color?: string;
  monogram?: ReactNode;
  className?: string;
};

function EntityAvatar({
  children,
  color = "#e08a3c",
}: {
  children: ReactNode;
  color?: string;
}) {
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none text-white"
      style={{ background: color }}
    >
      {children}
    </span>
  );
}

export function EntityChip({
  name,
  color,
  monogram,
  className = "",
}: EntityChipProps) {
  return (
    <span
      className={`mx-0.5 inline-flex items-center gap-1 rounded-full bg-field py-px pr-1.5 pl-[3px] align-middle shadow-hairline ${className}`}
    >
      <EntityAvatar color={color}>{monogram ?? name.charAt(0)}</EntityAvatar>
      <span className="text-[12px] font-medium text-ink">{name}</span>
    </span>
  );
}
