import type { ReactNode } from "react";

type SelectProps = {
  value?: string;
  onValueChange?: (value: string) => void;
  required?: boolean;
  children: ReactNode;
};

type ItemProps = {
  value: string;
  children: ReactNode;
};

export function Select({
  value = "",
  onValueChange,
  required,
  children,
}: SelectProps) {
  return (
    <select
      className="w-full rounded-sm border border-ink/20 bg-white/80 px-3 py-2 text-sm text-ink outline-none focus:border-rust focus:ring-1 focus:ring-rust"
      value={value}
      required={required}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  );
}

// Layout wrappers -- passthroughs, kept for call-site compatibility with
// the shadcn-style API the rest of the app already uses.
export function SelectTrigger({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function SelectContent({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function SelectValue({
  placeholder = "Select...",
}: {
  placeholder?: string;
}) {
  return (
    <option value="" disabled>
      {placeholder}
    </option>
  );
}

export function SelectItem({ value, children }: ItemProps) {
  return <option value={value}>{children}</option>;
}
