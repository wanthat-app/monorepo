import type { ReactNode } from "react";
import { BrandMark } from "./brand";
import { Switch } from "./components";

/**
 * Admin / Operations console modules (Wanthat Admin mock). This surface is desktop web,
 * English-only and LTR — the consumer RTL rules deliberately do not apply here. It shares the
 * evergreen tokens and primitives with the consumer app; these are the console-specific pieces.
 */

type SidebarTheme = "dark" | "light";

const SIDE_THEME: Record<
  SidebarTheme,
  { bg: string; text: string; muted: string; hair: string; card: string; nav: string }
> = {
  dark: {
    bg: "bg-ink border-inkborder",
    text: "text-white",
    muted: "text-inkmuted",
    hair: "bg-inkhair",
    card: "bg-inkcard border-inkhair",
    nav: "text-inknav hover:text-white",
  },
  light: {
    bg: "bg-surface border-line",
    text: "text-ink",
    muted: "text-muted",
    hair: "bg-line",
    card: "bg-base border-line",
    nav: "text-secondary hover:text-ink",
  },
};

// Fixed left sidebar (248px): brand + grouped nav + the admin user card pinned to the bottom.
export function Sidebar({
  theme = "dark",
  caption = "Operations",
  children,
  footer,
}: {
  theme?: SidebarTheme;
  caption?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = SIDE_THEME[theme];
  return (
    <aside className={`flex h-full w-[248px] shrink-0 flex-col border-e p-4 ${t.bg}`}>
      <div className="flex items-center gap-2.5 px-1.5 pt-1">
        <BrandMark height={30} />
        <span className="flex flex-col">
          <span
            className={`font-display text-[21px] font-bold leading-none tracking-[-0.03em] ${t.text}`}
          >
            wanthat
          </span>
          <span
            className={`mt-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] ${t.muted}`}
          >
            {caption}
          </span>
        </span>
      </div>
      <div className={`mb-4 mt-5 h-px ${t.hair}`} />
      <nav className="flex flex-1 flex-col">{children}</nav>
      {footer ? <div className="mt-auto pt-4">{footer}</div> : null}
    </aside>
  );
}

// Uppercase group label inside the sidebar ("Overview", "Settings").
export function SidebarSection({
  theme = "dark",
  children,
}: {
  theme?: SidebarTheme;
  children: ReactNode;
}) {
  return (
    <div
      className={`px-1.5 pb-2 pt-4 text-[10.5px] font-bold uppercase tracking-[0.13em] first:pt-0 ${SIDE_THEME[theme].muted}`}
    >
      {children}
    </div>
  );
}

// Sidebar nav item; the active item fills with the evergreen accent.
export function SidebarNavItem({
  theme = "dark",
  icon,
  active = false,
  onClick,
  children,
}: {
  theme?: SidebarTheme;
  icon?: ReactNode;
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-2.5 rounded-tile px-3 py-2.5 text-start text-sm font-semibold transition ${
        active ? "bg-accent text-white" : SIDE_THEME[theme].nav
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

// The admin user card pinned to the sidebar bottom: initials tile, name, role, sign-out.
export function AdminUserCard({
  theme = "dark",
  initials,
  name,
  roleLabel,
  onSignOut,
  signOutLabel = "Sign out",
}: {
  theme?: SidebarTheme;
  initials: string;
  name: string;
  roleLabel?: string;
  onSignOut?: () => void;
  signOutLabel?: string;
}) {
  const t = SIDE_THEME[theme];
  return (
    <div className={`flex items-center gap-2.5 rounded-field border p-2.5 px-3 ${t.card}`}>
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-tile bg-accent text-sm font-bold text-white">
        {initials}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] font-bold ${t.text}`}>{name}</span>
        {roleLabel ? <span className={`block text-[11px] ${t.muted}`}>{roleLabel}</span> : null}
      </span>
      <button type="button" onClick={onSignOut} aria-label={signOutLabel} className={t.muted}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
          <path d="M16 17l5-5-5-5" />
          <path d="M21 12H9" />
        </svg>
      </button>
    </div>
  );
}

// KPI stat card: label + icon tile, a big tabular value, and a tinted delta pill with context.
export function KpiCard({
  label,
  icon,
  tone = "accent",
  value,
  delta,
  deltaNote,
}: {
  label: string;
  icon: ReactNode;
  tone?: "accent" | "pending";
  value: string;
  delta?: string;
  deltaNote?: string;
}) {
  const tint = tone === "accent" ? "bg-accent-soft text-accent" : "bg-pending-soft text-pending";
  return (
    <div className="rounded-[18px] border border-line bg-surface p-[18px]">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-semibold text-muted">{label}</span>
        <span
          className={`flex h-[30px] w-[30px] items-center justify-center rounded-[9px] ${tint}`}
        >
          {icon}
        </span>
      </div>
      <div className="tabular mt-3 font-display text-3xl font-bold leading-none tracking-[-0.03em] text-ink">
        {value}
      </div>
      {delta ? (
        <div className="mt-2.5 flex items-center gap-1.5">
          <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-bold ${tint}`}>
            {delta}
          </span>
          {deltaNote ? <span className="text-[11.5px] text-subtle">{deltaNote}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

type MerchantStatusTone = "confirmed" | "awaiting" | "declined";
const MERCHANT_TONES: Record<MerchantStatusTone, { chip: string; dot: string }> = {
  confirmed: { chip: "bg-accent-soft text-accent", dot: "bg-accent" },
  awaiting: { chip: "bg-pending-soft text-pending", dot: "bg-pending" },
  declined: { chip: "bg-rejected-soft text-rejected", dot: "bg-rejected" },
};

// Merchant-confirmation chip — the primary signal in the approvals queue ("AliExpress confirmed",
// "Awaiting Amazon", "eBay declined"), with a colored dot.
export function MerchantStatusChip({
  tone,
  children,
}: {
  tone: MerchantStatusTone;
  children: ReactNode;
}) {
  const t = MERCHANT_TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${t.chip}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
      {children}
    </span>
  );
}

// Stacked status bar + legend (Confirmed / Pending / Rejected shares of tracked events).
export function StackedStatusBar({
  items,
}: {
  items: { label: string; pct: number; detail?: string; tone: MerchantStatusTone }[];
}) {
  const SWATCH: Record<MerchantStatusTone, string> = {
    confirmed: "bg-accent",
    awaiting: "bg-barpending",
    declined: "bg-barrejected",
  };
  return (
    <div>
      <div className="mb-5 flex h-3.5 overflow-hidden rounded-lg">
        {items.map((s) => (
          <div key={s.label} className={SWATCH[s.tone]} style={{ width: `${s.pct}%` }} />
        ))}
      </div>
      <div className="flex flex-col gap-3.5">
        {items.map((s) => (
          <div key={s.label} className="flex items-center gap-2.5">
            <span
              aria-hidden
              className={`h-[11px] w-[11px] shrink-0 rounded-[3px] ${SWATCH[s.tone]}`}
            />
            <span className="flex-1 text-[13.5px] font-semibold text-ink">{s.label}</span>
            <span className="tabular text-[13.5px] font-bold text-ink">{s.pct}%</span>
            {s.detail ? (
              <span className="tabular w-14 text-end text-xs text-subtle">{s.detail}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// Approvals-queue row. The merchant chip is the prominent signal; the manual override buttons are
// deliberately small and ghosted — manual action is the exception, not the rule.
export function ApprovalRow({
  thumb,
  product,
  user,
  when,
  status,
  amount,
  onApprove,
  onReject,
}: {
  thumb: ReactNode;
  product: string;
  user: string;
  when: string;
  status: ReactNode;
  amount: string;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const ghost =
    "flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border border-line bg-surface text-muted transition hover:text-ink";
  return (
    <div className="flex items-center border-t border-hairrow px-4 py-3">
      <div className="flex min-w-0 flex-[1.5] items-center gap-3">
        {thumb}
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold text-ink">{product}</span>
          <span className="block text-xs text-muted">
            {user} · {when}
          </span>
        </span>
      </div>
      <div className="w-[172px]">{status}</div>
      <div className="tabular w-[84px] text-end text-sm font-bold text-accent">{amount}</div>
      <div className="flex w-[84px] justify-end gap-1.5">
        <button type="button" onClick={onApprove} aria-label="Approve manually" className={ghost}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </button>
        <button type="button" onClick={onReject} aria-label="Reject" className={ghost}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// Configuration row: title + description on the start side, the control on the end side.
export function ConfigRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-5 border-t border-hairrow py-5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-ink">{title}</div>
        {description ? <div className="mt-0.5 text-[12.5px] text-muted">{description}</div> : null}
      </div>
      {children}
    </div>
  );
}

// Payout-method toggle row (admin config 2×2 grid): icon tile + label + ETA + a Switch.
export function MethodToggleRow({
  icon,
  label,
  eta,
  checked,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  eta?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-field border border-[#EAEFEC] bg-[#F7FAF8] px-4 py-3">
      <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-tile border border-line bg-surface text-ink">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        {eta ? <span className="block text-xs text-muted">{eta}</span> : null}
      </span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

// Sticky save bar at the bottom of the configuration page.
export function SaveBar({
  dirty,
  saved = false,
  dirtyHint = "Unsaved changes",
  savedHint = "Saved",
  discardLabel = "Discard",
  saveLabel = "Save changes",
  onDiscard,
  onSave,
}: {
  dirty: boolean;
  saved?: boolean;
  dirtyHint?: string;
  savedHint?: string;
  discardLabel?: string;
  saveLabel?: string;
  onDiscard?: () => void;
  onSave?: () => void;
}) {
  return (
    <div className="sticky bottom-0 flex items-center gap-3 rounded-t-card border border-line bg-surface px-5 py-3.5">
      <span
        className={`flex items-center gap-2 text-[13px] font-semibold ${saved ? "text-accent" : "text-muted"}`}
      >
        {saved ? (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        ) : dirty ? (
          <span aria-hidden className="h-2 w-2 rounded-full bg-pending" />
        ) : null}
        {saved ? savedHint : dirty ? dirtyHint : ""}
      </span>
      <div className="ms-auto flex gap-2.5">
        <button
          type="button"
          onClick={onDiscard}
          disabled={!dirty}
          className="rounded-tile border border-edge bg-surface px-4 py-2.5 text-[13.5px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
        >
          {discardLabel}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty}
          className="rounded-tile bg-accent px-4 py-2.5 text-[13.5px] font-bold text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:bg-accent-soft disabled:text-accent"
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

// Search field (admin top bar): base-grey, 12px radius, leading search glyph.
export function SearchField({
  placeholder,
  value,
  onChange,
  width = 260,
}: {
  placeholder: string;
  value?: string;
  onChange?: (value: string) => void;
  width?: number;
}) {
  return (
    <span
      className="flex items-center gap-2 rounded-input border border-divider bg-base px-3.5 py-2.5"
      style={{ width }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#9aa8a1"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-full border-none bg-transparent text-[13.5px] text-ink outline-none placeholder:text-placeholder"
      />
    </span>
  );
}

// Notification bell with the accent alert dot (admin top bar).
export function NotificationBell({
  hasAlert = false,
  onClick,
  label = "Notifications",
}: {
  hasAlert?: boolean;
  onClick?: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="relative flex h-[42px] w-[42px] items-center justify-center rounded-input border border-divider bg-base text-ink transition hover:bg-surface"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {hasAlert ? (
        <span
          aria-hidden
          className="absolute right-2.5 top-2 h-2 w-2 rounded-full border-2 border-base bg-accent"
        />
      ) : null}
    </button>
  );
}
