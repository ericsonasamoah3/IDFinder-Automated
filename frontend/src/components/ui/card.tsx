import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  className?: string;
};

export function Card({ children, className = "" }: Props) {
  return (
    <div
      className={`rounded-md border border-ink/10 bg-paper shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children, className = "" }: Props) {
  return (
    <div className={`px-6 pt-6 pb-3 border-b border-ink/10 ${className}`}>
      {children}
    </div>
  );
}

export function CardContent({ children, className = "" }: Props) {
  return <div className={`px-6 py-5 ${className}`}>{children}</div>;
}

export function CardTitle({ children, className = "" }: Props) {
  return (
    <div className={`font-display text-xl font-semibold text-ink ${className}`}>
      {children}
    </div>
  );
}
