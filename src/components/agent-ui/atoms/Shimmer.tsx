import type { CSSProperties, ReactNode } from "react";

export function Shimmer({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const style: CSSProperties = {
    backgroundImage:
      "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
    backgroundSize: "200% 100%",
    animation: "shimmer-text 1.8s linear infinite",
  };

  return (
    <span
      className={`inline-block bg-clip-text text-transparent ${className}`}
      style={style}
    >
      {children}
    </span>
  );
}
