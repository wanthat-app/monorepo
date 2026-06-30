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
  // 430px is the design's phone-frame width (Wanthat Shared Product – Flow).
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[430px] flex-col justify-center gap-6 p-6">
      {children}
    </main>
  );
}

// Square back affordance (40×40, 12px radius, hairline) used on the OTP and register steps. The
// chevron mirrors in RTL via the logical-direction rotate so "back" always points the natural way.
export function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-input border border-line bg-surface text-ink transition hover:bg-base"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="rtl:-scale-x-100"
      >
        <title>{label}</title>
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  );
}

// One-time-code field: large centered Space Grotesk digits on a 16px-radius card, dashes for the
// empty state. Always LTR (digits read left-to-right even in the RTL layout). The caller keeps the
// length contract — Cognito SMS OTP is 6 digits.
export function OtpInput({
  value,
  onChange,
  label,
  error,
  name = "code",
  maxLength = 6,
  placeholder = "––––––",
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  error?: string;
  name?: string;
  maxLength?: number;
  placeholder?: string;
}) {
  return (
    <label htmlFor={name} className="block">
      {label ? <span className="mb-1.5 block text-sm font-medium text-muted">{label}</span> : null}
      <input
        id={name}
        name={name}
        type="tel"
        inputMode="numeric"
        autoComplete="one-time-code"
        dir="ltr"
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
        className={`w-full rounded-2xl border bg-surface p-5 text-center font-display text-[34px] font-semibold tracking-[0.5em] text-ink outline-none transition focus:border-accent ${
          error ? "border-rejected" : "border-line"
        }`}
      />
      {error ? <span className="mt-1 block text-sm text-rejected">{error}</span> : null}
    </label>
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

// Wordmark mark used on the admin sidebar: a rounded evergreen tile with a "W" monogram. Rendered as
// markup (no binary asset) so it tints cleanly on the dark sidebar and mirrors with the layout.
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-[9px] bg-accent font-display font-bold text-white"
      style={{ width: size, height: size, fontSize: size * 0.5 }}
    >
      W
    </span>
  );
}

// Switch toggle (Wanthat Admin → booleans / auto-approve): a 46×27 pill whose 21px knob slides on the
// inline (logical) axis, so it mirrors correctly in RTL. Track turns evergreen when on.
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[27px] w-[46px] shrink-0 rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-[#d2dad6]"
      }`}
    >
      <span
        aria-hidden
        className="absolute top-[3px] h-[21px] w-[21px] rounded-full bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-all"
        style={{ insetInlineStart: checked ? 22 : 3 }}
      />
    </button>
  );
}

// Range slider (Wanthat Admin → margins & rewards). The accent→line fill gradient is computed from the
// value; in RTL the gradient and the native control both run end-to-start. `format` renders the live
// numeric label (e.g. a percentage) beside the track.
export function RangeSlider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  label: string;
  format?: (value: number) => string;
}) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const fillTo = rtl ? "left" : "right";
  return (
    <div className="flex items-center gap-4">
      <input
        type="range"
        className="range flex-1"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          background: `linear-gradient(to ${fillTo}, #1f7a57 ${pct}%, #e2e7e4 ${pct}%)`,
        }}
      />
      <div className="tabular w-16 text-end font-display text-lg font-bold text-ink">
        {format ? format(value) : value}
      </div>
    </div>
  );
}
