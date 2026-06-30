import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/**
 * Shared design-system primitives (Wanthat Design System). Recreated as React + Tailwind from the
 * `.dc.html` prototypes — the prototype runtime is reference only, not imported. Reused by both the
 * member and admin UIs.
 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "mint" | "outline";
  loading?: boolean;
};

// Per the design system: primary (evergreen), ghost (text link), outline (hairline), and the mint
// CTA (#7FE0B0 on #0E1A14, 14px radius) reserved for the dark balance/offer surfaces.
const BUTTON_VARIANTS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "rounded-button bg-accent text-white hover:bg-accent/90 active:bg-accent",
  ghost: "rounded-button bg-transparent text-accent hover:bg-accent-soft",
  outline: "rounded-button border border-line bg-surface text-ink hover:bg-base",
  mint: "rounded-[14px] bg-mint text-[#0E1A14] hover:bg-mint/90 active:bg-mint",
};

export function Button({ variant = "primary", loading, children, disabled, ...rest }: ButtonProps) {
  const base =
    "inline-flex h-12 w-full items-center justify-center gap-2 px-5 font-display font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed";
  return (
    <button
      className={`${base} ${BUTTON_VARIANTS[variant]}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner /> : children}
    </button>
  );
}

type Status = "confirmed" | "pending" | "rejected" | "neutral";

// Status chip (Wanthat Design System → Status & badges). Earthy, muted hues on a base-grey pill so
// they never feel alarming on a money surface; Confirmed reuses the evergreen accent.
const STATUS_COLORS: Record<Status, string> = {
  confirmed: "text-accent",
  pending: "text-pending",
  rejected: "text-rejected",
  neutral: "text-muted",
};

export function StatusBadge({
  status = "neutral",
  children,
}: {
  status?: Status;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full bg-base px-3 py-1.5 text-xs font-bold ${STATUS_COLORS[status]}`}
    >
      {children}
    </span>
  );
}

type SegmentedOption<T extends string> = { value: T; label: ReactNode };

// Segmented toggle (Wanthat Design System → Inputs & controls). The active segment lifts onto a white
// pill; reused by the language selector. Logical padding so it mirrors cleanly in RTL.
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    // Each option button carries visible text + aria-pressed, so the group needs no extra role.
    <div className="inline-flex rounded-input border border-line bg-base p-[3px]">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={`rounded-lg px-4 py-1.5 text-sm font-bold transition ${
              active ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// Square check used by the Terms & Privacy gate (matches the design's 22px / 7px-radius control).
export function Checkbox({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden
        className={`mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px] border transition ${
          checked ? "border-accent bg-accent text-white" : "border-subtle bg-surface"
        }`}
      >
        {checked ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <title>checked</title>
            <path d="M20 6L9 17l-5-5" />
          </svg>
        ) : null}
      </span>
      <span className="text-sm leading-snug text-muted">{children}</span>
    </label>
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
