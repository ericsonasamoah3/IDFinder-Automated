import type { ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "ghost" | "destructive";
  size?: "default" | "icon";
};

const variants: Record<string, string> = {
  default:
    "bg-rust text-cream hover:bg-rust-dark border border-rust-dark focus-visible:ring-2 focus-visible:ring-brass",
  ghost:
    "bg-transparent text-cream border border-cream/30 hover:bg-cream/10 focus-visible:ring-2 focus-visible:ring-brass",
  destructive:
    "bg-transparent text-rust border border-rust hover:bg-rust/10 focus-visible:ring-2 focus-visible:ring-rust",
};

const sizes: Record<string, string> = {
  default: "px-5 py-2.5 text-sm",
  icon: "p-2",
};

export function Button({
  variant = "default",
  size = "default",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-sm font-medium tracking-wide transition-colors outline-none disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
