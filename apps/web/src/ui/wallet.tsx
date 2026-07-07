import type { ReactNode } from "react";
import { Logo } from "./brand";
import { IconTile, Skeleton, SkeletonCircle } from "./components";

/**
 * Consumer (wallet) modules of the Wanthat Design System — the balance card, activity rows,
 * payout-method picker, navigation and social pieces from the design handoff's Wallet and
 * Shared-Product flows. All money strings are rendered LTR with tabular numerals by callers
 * passing preformatted text (₪ leading); rows use logical properties so they mirror in RTL.
 */

type AvatarKind = "initial" | "product" | "placeholder";

// Avatars from the design system: a person is a circle initial on accent-soft; a product is a
// 13px-radius tile with the image contained on white; no image yet renders the striped placeholder.
export function Avatar({
  kind = "initial",
  size = 44,
  initial,
  src,
  alt = "",
}: {
  kind?: AvatarKind;
  size?: number;
  initial?: string;
  src?: string;
  alt?: string;
}) {
  if (kind === "initial") {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full border border-accent-border bg-accent-soft font-bold text-accent"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.32) }}
      >
        {initial}
      </span>
    );
  }
  if (kind === "product" && src) {
    return (
      <span
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-thumb border border-line bg-surface"
        style={{ width: size, height: size }}
      >
        <img src={src} alt={alt} className="max-h-full max-w-full object-contain" />
      </span>
    );
  }
  return (
    <span
      className="block shrink-0 rounded-thumb border border-line"
      style={{
        width: size,
        height: size,
        background:
          "repeating-linear-gradient(135deg,#EDF1EF,#EDF1EF 5px,#F4F6F5 5px,#F4F6F5 10px)",
      }}
    />
  );
}

// The round initial button in the top corner of Home / the top nav — opens the profile.
export function ProfileChip({
  initial,
  onClick,
  label,
  size = 38,
}: {
  initial: string;
  onClick?: () => void;
  label?: string;
  size?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label ?? "Profile"}
      className="flex shrink-0 items-center justify-center rounded-full border border-accent-border bg-accent-soft font-bold text-accent transition hover:bg-accent-soft/70"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.37) }}
    >
      {initial}
    </button>
  );
}

// Soft-green attribution chip — "<Name> sent you a cashback link" — with the sender's initial.
export function AttributionChip({
  initial,
  children,
  loading = false,
}: {
  initial?: string;
  children?: ReactNode;
  loading?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-field border border-accent-border bg-accent-soft px-3.5 py-2.5"
      aria-busy={loading || undefined}
    >
      {loading ? (
        <>
          <SkeletonCircle size={32} />
          <Skeleton className="h-3.5 w-48" />
        </>
      ) : (
        <>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-bold text-white">
            {initial}
          </span>
          <span className="text-[13px] leading-[1.35] text-accent-deep">{children}</span>
        </>
      )}
    </div>
  );
}

// A referrer's recommendation: light quote bubble with paired quote marks and a caret pointing up
// to the attribution chip above it. Flips for RTL via logical properties.
export function RecommendationQuote({
  children,
  loading = false,
}: {
  children?: ReactNode;
  loading?: boolean;
}) {
  const quoteMark = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#BCD3C7" stroke="none" aria-hidden="true">
      <path d="M10 11H6.5a.5.5 0 0 1-.5-.5V9c0-1.6 1.1-2.7 2.7-3.2l.5 1.3C8.4 7.4 8 8 8 8.8h2a.5.5 0 0 1 .5.5V11zm8 0h-3.5a.5.5 0 0 1-.5-.5V9c0-1.6 1.1-2.7 2.7-3.2l.5 1.3c-.8.3-1.2.9-1.2 1.7h2a.5.5 0 0 1 .5.5V11z" />
    </svg>
  );
  return (
    <div className="relative ms-1.5 rounded-field border border-[#EAEFEC] bg-[#F7FAF8] px-4 pb-3 pt-3.5">
      <span
        aria-hidden
        className="absolute -top-1.5 h-2.5 w-2.5 rotate-45 border-s border-t border-[#EAEFEC] bg-[#F7FAF8]"
        style={{ insetInlineStart: 14 }}
      />
      {quoteMark}
      {loading ? (
        <div className="my-0.5 flex flex-col gap-1.5 py-0.5" aria-busy="true">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      ) : (
        <div className="my-0.5 text-sm leading-[1.55] text-[#3A4742]">{children}</div>
      )}
      <div className="text-end">
        <span className="inline-block rotate-180">{quoteMark}</span>
      </div>
    </div>
  );
}

// Shared-product card on the referral landing: contained product image over a title + price row.
export function ProductCard({
  src,
  title,
  price,
  priceNote,
  meta,
  loading = false,
}: {
  src?: string;
  title?: string;
  price?: string;
  priceNote?: string;
  meta?: string;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div
        className="overflow-hidden rounded-[22px] border border-line bg-surface"
        aria-busy="true"
      >
        <div className="flex h-[204px] items-center justify-center border-b border-line bg-surface p-3.5">
          <Skeleton className="h-full w-full rounded-thumb" />
        </div>
        <div className="px-[18px] py-4">
          <Skeleton className="mb-2.5 h-4 w-3/4" />
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-[22px] border border-line bg-surface">
      <div className="flex h-[204px] items-center justify-center border-b border-line bg-surface p-3.5">
        <img src={src} alt={title} className="max-h-full max-w-full object-contain" />
      </div>
      <div className="px-4.5 py-4 px-[18px]">
        <div className="mb-2 text-[17px] font-bold leading-[1.25] text-ink">{title}</div>
        <div className="flex items-center gap-2.5">
          <span className="tabular text-lg font-bold text-ink">{price}</span>
          {priceNote ? <span className="text-[12.5px] text-muted">{priceNote}</span> : null}
          {meta ? <span className="ms-auto text-xs font-semibold text-muted">{meta}</span> : null}
        </div>
      </div>
    </div>
  );
}

// The dark balance card — the wallet's hero. The headline is the estimated ILS total (≈ prefix);
// real per-currency holdings render as small chips beneath, with the pending note under those.
export function BalanceCard({
  label,
  chip,
  amount,
  fraction,
  approx = false,
  holdings,
  holdingsNote,
  pendingNote,
  cta,
  onCta,
  children,
  loading = false,
}: {
  label: string;
  chip?: ReactNode;
  amount?: string;
  fraction?: string;
  approx?: boolean;
  holdings?: string[];
  holdingsNote?: string;
  pendingNote?: string;
  cta?: string;
  onCta?: () => void;
  children?: ReactNode;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-feature bg-ink p-6 pb-5 text-onink" aria-busy="true">
        <div className="mb-3.5 flex items-center justify-between">
          <Skeleton onInk className="h-3.5 w-32" />
          <Skeleton onInk className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton onInk className="mb-3 h-[46px] w-44" />
        <div className="mb-3.5 flex items-center gap-1.5">
          <Skeleton onInk className="h-6 w-16 rounded-full" />
          <Skeleton onInk className="h-6 w-14 rounded-full" />
        </div>
        <Skeleton onInk className="mb-5 h-3.5 w-52" />
        {cta ? <Skeleton onInk className="h-[50px] w-full rounded-[14px]" /> : null}
      </div>
    );
  }
  return (
    <div className="rounded-feature bg-ink p-6 pb-5 text-onink">
      <div className="mb-3.5 flex items-center justify-between">
        <span className="text-[13px] font-medium text-onink-muted">{label}</span>
        {chip}
      </div>
      <div
        className="tabular mb-3 font-display text-[46px] font-bold leading-none tracking-[-0.03em]"
        dir="ltr"
      >
        {approx ? <span className="text-2xl font-semibold text-onink-muted">≈</span> : null}
        {amount}
        {fraction ? <span className="text-[28px] text-onink-muted">{fraction}</span> : null}
      </div>
      {holdings?.length ? (
        <div className="mb-3.5 flex flex-wrap items-center gap-1.5" dir="ltr">
          {holdings.map((h) => (
            <span
              key={h}
              className="tabular rounded-full bg-white/10 px-2.5 py-1 text-[12.5px] font-semibold text-onink"
            >
              {h}
            </span>
          ))}
          {holdingsNote ? (
            <span className="text-[11.5px] text-onink-faint">{holdingsNote}</span>
          ) : null}
        </div>
      ) : null}
      {pendingNote ? (
        <div className="mb-5 flex items-center gap-2">
          <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#E0B85F]" />
          <span className="tabular text-[13px] text-onink-soft">{pendingNote}</span>
        </div>
      ) : null}
      {children}
      {cta ? (
        <button
          type="button"
          onClick={onCta}
          className="w-full rounded-[14px] bg-mint p-3.5 font-display text-[15px] font-bold text-mint-ink transition hover:bg-mint/90"
        >
          {cta}
        </button>
      ) : null}
    </div>
  );
}

type RowStatus = "confirmed" | "pending" | "rejected" | "neutral";
const ROW_STATUS_TEXT: Record<RowStatus, string> = {
  confirmed: "text-accent",
  pending: "text-pending",
  rejected: "text-rejected",
  neutral: "text-muted",
};

// Activity / earning row: thumb, title, colored status + meta line, and the dual amount —
// estimated ILS large over the real source-currency cashback.
export function ActivityRow({
  thumb,
  title,
  status = "neutral",
  statusLabel,
  meta,
  amount,
  amountSub,
  onClick,
  loading = false,
}: {
  thumb?: ReactNode;
  title?: string;
  status?: RowStatus;
  statusLabel?: string;
  meta?: string;
  amount?: string;
  amountSub?: string;
  onClick?: () => void;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex w-full items-center gap-3 px-0.5 py-3" aria-busy="true">
        <Skeleton className="h-11 w-11 rounded-thumb" />
        <span className="min-w-0 flex-1">
          <Skeleton className="mb-1.5 h-3.5 w-36" />
          <Skeleton className="h-3 w-24" />
        </span>
        <span className="flex flex-col items-end">
          <Skeleton className="mb-1.5 h-3.5 w-14" />
          <Skeleton className="h-2.5 w-10" />
        </span>
      </div>
    );
  }
  const body = (
    <>
      {thumb}
      <span className="min-w-0 flex-1 text-start">
        <span className="block truncate text-sm font-semibold text-ink">{title}</span>
        <span className="block text-xs">
          {statusLabel ? (
            <span className={`font-semibold ${ROW_STATUS_TEXT[status]}`}>{statusLabel}</span>
          ) : null}
          {meta ? (
            <span className="text-muted">
              {statusLabel ? " · " : ""}
              {meta}
            </span>
          ) : null}
        </span>
      </span>
      <span className="text-end">
        <span
          className={`tabular block text-sm font-bold ${status === "neutral" ? "text-ink" : ROW_STATUS_TEXT[status]}`}
          dir="ltr"
        >
          {amount}
        </span>
        {amountSub ? (
          <span className="tabular block text-[11px] font-semibold text-subtle" dir="ltr">
            {amountSub}
          </span>
        ) : null}
      </span>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3 px-0.5 py-3 text-start"
      >
        {body}
      </button>
    );
  }
  return <div className="flex w-full items-center gap-3 px-0.5 py-3">{body}</div>;
}

type MethodBrand = "bank" | "card" | "bit" | "paybox";

// Generic payout-method glyph tiles (used until real details/brand art exist — per the handoff,
// a real logo only appears once details are saved).
const METHOD_TILES: Record<MethodBrand, { bg: string; fg: string; icon: ReactNode }> = {
  bank: {
    bg: "bg-bank-soft",
    fg: "text-bank",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 9.5L12 4l9 5.5" />
        <path d="M5 10v9M19 10v9M9.5 10v9M14.5 10v9" />
        <path d="M3 21h18" />
      </svg>
    ),
  },
  card: {
    bg: "bg-cardpay-soft",
    fg: "text-cardpay",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M2 10h20M6 15h4" />
      </svg>
    ),
  },
  bit: {
    bg: "bg-bit-soft",
    fg: "text-bit",
    icon: <span className="text-[13px] font-extrabold">bit</span>,
  },
  paybox: {
    bg: "bg-paybox-soft",
    fg: "text-paybox",
    icon: <span className="text-[10px] font-extrabold">PayBox</span>,
  },
};

export function MethodTile({ brand }: { brand: MethodBrand }) {
  const t = METHOD_TILES[brand];
  return (
    <span
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-tile ${t.bg} ${t.fg}`}
    >
      {t.icon}
    </span>
  );
}

// Selectable payout-method row: logo/glyph tile + label + detail line + evergreen check when
// selected. `logo` (e.g. a real brand image once details are saved) wins over the generic tile.
export function MethodRow({
  brand,
  logo,
  label,
  detail,
  selected = false,
  onSelect,
  loading = false,
}: {
  brand?: MethodBrand;
  logo?: ReactNode;
  label?: string;
  detail?: string;
  selected?: boolean;
  onSelect?: () => void;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div
        className="mb-2.5 flex w-full items-center gap-3 rounded-chip border border-line bg-surface p-3 pe-4"
        aria-busy="true"
      >
        <Skeleton className="h-10 w-10 rounded-tile" />
        <span className="min-w-0 flex-1">
          <Skeleton className="mb-1.5 h-3.5 w-28" />
          <Skeleton className="h-3 w-36" />
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`mb-2.5 flex w-full items-center gap-3 rounded-chip border bg-surface p-3 pe-4 text-start transition ${
        selected ? "border-accent" : "border-line hover:border-edge"
      }`}
    >
      {logo ?? (brand ? <MethodTile brand={brand} /> : null)}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-ink">{label}</span>
        {detail ? (
          <span className="tabular block text-[12.5px] text-muted" dir="ltr">
            {detail}
          </span>
        ) : null}
      </span>
      {selected ? (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#1F7A57"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : null}
    </button>
  );
}

// Soft-green prompt card (Set up Face ID, OTP reassurance): icon tile + copy + optional action.
export function PromptCard({
  icon,
  title,
  subtitle,
  actionLabel,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[18px] border border-accent-border bg-accent-soft p-3.5">
      <IconTile tone="accent">{icon}</IconTile>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-ink">{title}</span>
        {subtitle ? (
          <span className="block text-xs leading-[1.35] text-accent-deep">{subtitle}</span>
        ) : null}
      </span>
      {actionLabel ? (
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 rounded-tile bg-accent px-3.5 py-2.5 text-[13px] font-bold text-white transition hover:bg-accent/90"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

// Icon-tile + title + sub — the value-prop rows on the logged-out landing.
export function FeatureRow({
  icon,
  title,
  subtitle,
  loading = false,
}: {
  icon?: ReactNode;
  title?: string;
  subtitle?: string;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-3" aria-busy="true">
        <Skeleton className="h-[42px] w-[42px] rounded-input" />
        <span className="min-w-0 flex-1">
          <Skeleton className="mb-1.5 h-3.5 w-36" />
          <Skeleton className="h-3 w-48" />
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <IconTile tone="soft">{icon}</IconTile>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-ink">{title}</span>
        {subtitle ? <span className="block text-[12.5px] text-muted">{subtitle}</span> : null}
      </span>
    </div>
  );
}

// Filter pills (activity filters, admin merchant tabs): active pill fills ink, inactive stays
// white with a hairline.
export function PillTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="scr flex gap-2 overflow-x-auto">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={`shrink-0 rounded-full px-4 py-2 text-[13px] font-bold transition ${
              active
                ? "bg-ink text-white"
                : "border border-edge bg-surface text-secondary hover:text-ink"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// Settings row (profile screen): small icon tile, label, and a trailing control/value.
export function SettingsRow({
  icon,
  tone = "soft",
  label,
  trailing,
  onClick,
  loading = false,
}: {
  icon?: ReactNode;
  tone?: "soft" | "base";
  label?: string;
  trailing?: ReactNode;
  onClick?: () => void;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div
        className="flex w-full items-center gap-3 border-b border-hairrow p-4 last:border-b-0"
        aria-busy="true"
      >
        <Skeleton className="h-[34px] w-[34px] rounded-[10px]" />
        <Skeleton className="h-3.5 w-32 flex-none" />
        <span className="ms-auto">
          <Skeleton className="h-6 w-16 rounded-full" />
        </span>
      </div>
    );
  }
  const inner = (
    <>
      <IconTile tone={tone} size={34}>
        {icon}
      </IconTile>
      <span className="flex-1 text-start text-[14.5px] font-semibold text-ink">{label}</span>
      {trailing}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3 border-b border-hairrow p-4 last:border-b-0"
      >
        {inner}
      </button>
    );
  }
  return (
    <div className="flex w-full items-center gap-3 border-b border-hairrow p-4 last:border-b-0">
      {inner}
    </div>
  );
}

// Dark invite card (profile): referral code with a mint copy affordance.
export function InviteCard({
  title,
  subtitle,
  code,
  copyLabel,
  onCopy,
  loading = false,
}: {
  title?: string;
  subtitle?: string;
  code?: string;
  copyLabel?: string;
  onCopy?: () => void;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-card bg-ink p-5 text-onink" aria-busy="true">
        <Skeleton onInk className="mb-2 h-3.5 w-44" />
        <Skeleton onInk className="mb-1.5 h-3 w-full" />
        <Skeleton onInk className="mb-3.5 h-3 w-2/3" />
        <Skeleton onInk className="h-11 w-full rounded-thumb" />
      </div>
    );
  }
  return (
    <div className="rounded-card bg-ink p-5 text-onink">
      <div className="mb-1 text-sm font-bold">{title}</div>
      {subtitle ? (
        <div className="mb-3.5 text-[12.5px] leading-[1.45] text-onink-muted">{subtitle}</div>
      ) : null}
      <div className="flex items-center gap-2.5 rounded-thumb bg-white/[.07] p-1.5 ps-4" dir="ltr">
        <span className="tabular min-w-0 flex-1 truncate text-[15px] font-bold">{code}</span>
        <button
          type="button"
          onClick={onCopy}
          className="shrink-0 rounded-[10px] bg-mint px-3.5 py-2 text-[13px] font-bold text-mint-ink transition hover:bg-mint/90"
        >
          {copyLabel}
        </button>
      </div>
    </div>
  );
}

// White share row for a created link: the short link + an ink copy button.
export function ShareLinkRow({
  link,
  copyLabel,
  onCopy,
  loading = false,
}: {
  link?: string;
  copyLabel?: string;
  onCopy?: () => void;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div
        className="flex items-center gap-2.5 rounded-field border border-line bg-surface p-1.5 ps-4"
        dir="ltr"
        aria-busy="true"
      >
        <Skeleton className="h-3.5 w-32" />
        <span className="ms-auto">
          <Skeleton className="h-10 w-[72px] rounded-[10px]" />
        </span>
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-2.5 rounded-field border border-line bg-surface p-1.5 ps-4"
      dir="ltr"
    >
      <span className="tabular min-w-0 flex-1 truncate text-sm font-semibold text-ink">{link}</span>
      <button
        type="button"
        onClick={onCopy}
        className="shrink-0 rounded-[10px] bg-ink px-4 py-2.5 text-[13px] font-bold text-white transition hover:bg-ink/90"
      >
        {copyLabel}
      </button>
    </div>
  );
}

const HOME_ICON = (
  <svg
    width="23"
    height="23"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 10.5L12 3l9 7.5" />
    <path d="M5 9.5V20h14V9.5" />
  </svg>
);
const ACTIVITY_ICON = (
  <svg
    width="23"
    height="23"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 18V9M9 18V5M14 18v-6M19 18v-9" />
  </svg>
);
const PLUS_ICON = (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
);

// Mobile bottom navigation: Home / centre create FAB / Activity, on a translucent blurred bar.
export function TabBar({
  homeLabel,
  activityLabel,
  active,
  onHome,
  onActivity,
  onCreate,
  createLabel,
}: {
  homeLabel: string;
  activityLabel: string;
  active: "home" | "activity";
  onHome?: () => void;
  onActivity?: () => void;
  onCreate?: () => void;
  createLabel?: string;
}) {
  const item = (label: string, icon: ReactNode, isActive: boolean, onClick?: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-1 ${isActive ? "text-accent" : "text-placeholder"}`}
    >
      {icon}
      <span className="text-[10.5px] font-bold">{label}</span>
    </button>
  );
  return (
    <nav className="flex items-center justify-between border-t border-line bg-white/95 px-8 pb-6 pt-2.5 backdrop-blur-md">
      {item(homeLabel, HOME_ICON, active === "home", onHome)}
      <button
        type="button"
        onClick={onCreate}
        aria-label={createLabel ?? "Create"}
        className="-mt-1 flex h-[52px] w-[52px] items-center justify-center rounded-[17px] bg-accent text-white shadow-fab transition hover:bg-accent/90"
      >
        {PLUS_ICON}
      </button>
      {item(activityLabel, ACTIVITY_ICON, active === "activity", onActivity)}
    </nav>
  );
}

// Desktop top app bar: brand lockup, pill nav links, + Create, and the profile chip.
export function TopNav({
  links,
  onCreate,
  createLabel,
  profileInitial,
  onProfile,
}: {
  links: { key: string; label: string; active?: boolean; onClick?: () => void }[];
  onCreate?: () => void;
  createLabel?: string;
  profileInitial?: string;
  onProfile?: () => void;
}) {
  return (
    <nav className="flex items-center gap-2 border-b border-line bg-surface px-7 py-3">
      <Logo size="sm" />
      <div className="ms-5 flex gap-1">
        {links.map((l) => (
          <button
            key={l.key}
            type="button"
            onClick={l.onClick}
            className={`rounded-[10px] px-3.5 py-2 text-[13px] font-bold transition ${
              l.active ? "bg-accent-soft text-accent" : "text-secondary hover:text-ink"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      {createLabel ? (
        <button
          type="button"
          onClick={onCreate}
          className="ms-auto rounded-tile bg-accent px-4 py-2 text-[13.5px] font-bold text-white transition hover:bg-accent/90"
        >
          + {createLabel}
        </button>
      ) : null}
      {profileInitial ? (
        <span className={createLabel ? "ms-1.5" : "ms-auto"}>
          <ProfileChip initial={profileInitial} onClick={onProfile} size={36} />
        </span>
      ) : null}
    </nav>
  );
}
