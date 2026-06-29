import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/**
 * Shared design-system primitives (Wanthat Design System). Recreated as React + Tailwind from the
 * `.dc.html` prototypes — the prototype runtime is reference only, not imported. Reused by both the
 * member and admin UIs.
 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost";
  loading?: boolean;
};

export function Button({ variant = "primary", loading, children, disabled, ...rest }: ButtonProps) {
  const base =
    "inline-flex h-12 w-full items-center justify-center gap-2 rounded-button px-5 font-display font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed";
  const styles =
    variant === "primary"
      ? "bg-accent text-white hover:bg-accent/90 active:bg-accent"
      : "bg-transparent text-accent hover:bg-accent-soft";
  return (
    <button className={`${base} ${styles}`} disabled={disabled || loading} {...rest}>
      {loading ? <Spinner /> : children}
    </button>
  );
}

type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
};

export function TextField({ label, error, id, ...rest }: TextFieldProps) {
  const inputId = id ?? rest.name;
  return (
    <label htmlFor={inputId} className="block">
      <span className="mb-1.5 block text-sm font-medium text-muted">{label}</span>
      <input
        id={inputId}
        className={`h-12 w-full rounded-input border bg-surface px-4 text-ink outline-none transition focus:border-accent ${
          error ? "border-rejected" : "border-line"
        }`}
        {...rest}
      />
      {error ? <span className="mt-1 block text-sm text-rejected">{error}</span> : null}
    </label>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-card bg-surface p-6 shadow-card ${className}`}>{children}</div>;
}

export function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 p-6">
      {children}
    </main>
  );
}

export function Spinner() {
  // Inherits currentColor so it reads on both the accent button (white) and light screens.
  return (
    <span
      role="status"
      aria-label="loading"
      className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
    />
  );
}

export function Logo() {
  return <div className="font-display text-3xl font-bold text-accent">Wanthat</div>;
}
