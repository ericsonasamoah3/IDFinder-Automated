import type { TextareaHTMLAttributes } from "react";

export function Textarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-sm border border-ink/20 bg-white/80 px-3 py-2 text-sm text-ink placeholder:text-ink/40 outline-none focus:border-rust focus:ring-1 focus:ring-rust ${className}`}
      {...props}
    />
  );
}
