import type { LabelHTMLAttributes } from "react";

export function Label({
  className = "",
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={`block text-xs font-semibold uppercase tracking-wider text-ink/70 mb-1.5 ${className}`}
      {...props}
    />
  );
}
