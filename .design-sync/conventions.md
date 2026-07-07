# Wanthat Design System — build conventions

Wanthat is an Israeli two-sided cashback app: evergreen fintech look, bilingual EN/Hebrew (RTL),
money always ₪-led. Components come in four groups: **shared** primitives (Button, TextField,
Card, Screen, …), **brand** (Logo, BrandMark — the real logo asset, never a synthesized glyph),
**wallet** consumer modules (BalanceCard, ActivityRow, MethodRow, TabBar, TopNav, …), and
**admin** console modules (Sidebar, KpiCard, ConfigRow, …). No provider or theme wrapper is
needed — import from `window.Wanthat` and render.

## Styling idiom: Tailwind utility classes with Wanthat tokens

Style layout glue with these token classes (they are compiled into `styles.css`; the stylesheet is
a **fixed compiled set** — arbitrary Tailwind values like `w-[413px]` that aren't already in it
will NOT resolve, so prefer the classes below and inline `style={{…}}` for one-off dimensions):

| Family | Classes |
|---|---|
| Surfaces | `bg-page` (app bg #E9EDEB) · `bg-base` (#F4F6F5) · `bg-surface` (white) · `bg-ink` (dark #15201C) · `bg-accent` (#1F7A57) · `bg-accent-soft` (#E7F1EC) · `bg-mint` (#7FE0B0) |
| Text | `text-ink` · `text-secondary` (#5C6B64) · `text-muted` (#6B7B73) · `text-subtle` (#8A968F) · `text-accent` · `text-pending` (#B07A1E) · `text-rejected` (#B0473A); on dark surfaces: `text-onink`, `text-onink-muted`, `text-onink-soft` |
| Borders | `border-line` (hairline #E6EBE8) · `border-edge` (inputs #E0E6E3) · `border-divider` · `border-accent-border` |
| Radius | `rounded-input` (12) · `rounded-field` (14, text inputs) · `rounded-button` (15) · `rounded-chip` (16) · `rounded-card` (20) · `rounded-feature` (24, dark hero cards) · `rounded-tile` (11) · `rounded-thumb` (13, product thumbs) |
| Type | `font-display` (Space Grotesk — headings/wordmark/money) · `font-body` (Hanken Grotesk; Heebo serves Hebrew automatically) |
| Elevation | hairline borders first; `shadow-card` only for lifted surfaces; `shadow-segment`, `shadow-fab` |

Standard spacing/flex/grid utilities (`flex`, `grid`, `gap-*`, `p-*`, `m-*`, `w-full`, `text-sm`…)
are available. `h1`–`h3` already render in Space Grotesk 600.

## Non-negotiable product rules

- **Money is always LTR with tabular numerals and a leading ₪, even in Hebrew.** Wrap every
  monetary figure: `<span className="tabular" dir="ltr">₪142.50</span>`. Estimated totals get a
  `≈` prefix and real per-currency amounts render small beneath (see `BalanceCard`, `ActivityRow`).
- **RTL:** Hebrew screens set `dir="rtl"` on the container; components use logical properties and
  mirror automatically. Use `ms-*`/`me-*`/`ps-*`/`pe-*`/`text-start`/`text-end`, never `ml/mr`.
- The mint CTA (`variant="mint"` / `bg-mint`) appears **only on dark ink surfaces**.
- Disabled/loading buttons are soft-green (`bg-accent-soft text-accent`) — never faded.
- **Loading states:** every data-bearing component (`BalanceCard`, `ActivityRow`, `ProductCard`,
  `KpiCard`, `ApprovalRow`, `MethodRow`, `SettingsRow`, `InviteCard`, `ShareLinkRow`,
  `StackedStatusBar`, `AttributionChip`, `RecommendationQuote`, `FeatureRow`) takes
  `loading?: boolean` and renders a pulsing skeleton with the same geometry — no layout shift when
  data lands. For custom layouts compose the `Skeleton` primitive directly
  (`<Skeleton className="h-4 w-3/4" />`; `onInk` on dark surfaces; `SkeletonCircle` for avatars).
- Consumer screens live in a centered ~430px column (`Screen`) on `bg-page`; mobile nav is
  `TabBar`, desktop nav is `TopNav`. The admin console is desktop-only, English/LTR, with
  `Sidebar` (248px, light by default; a dark variant exists via `theme="dark"`).

## Where the truth lives

Read `styles.css` (+ its `@import`ed `_ds_bundle.css`) for the full compiled class set, each
component's `.prompt.md` for its API and examples, and `guidelines/README.md` — the full design
handoff with screen-by-screen flows, copy in both languages, and the exact token spec.

## Idiomatic example

```jsx
const { Screen, Card, BalanceCard, Chip, ActivityRow, Avatar, Button } = window.Wanthat;

<Screen>
  <BalanceCard
    label="Available cashback"
    chip={<Chip tone="mint">Estimated</Chip>}
    approx amount="₪142" fraction=".50"
    holdings={["$36.20", "€2.14"]} holdingsNote="held in original currencies"
    pendingNote="≈₪68.20 pending confirmation"
    cta="Withdraw cash" onCta={() => {}}
  />
  <Card className="flex flex-col gap-1">
    <div className="flex items-center justify-between pb-2">
      <h2 className="text-lg">Recent activity</h2>
      <button className="text-sm font-semibold text-accent">See all</button>
    </div>
    <ActivityRow
      thumb={<Avatar kind="placeholder" size={44} />}
      title="USB-C 7-in-1 Hub" status="pending" statusLabel="Pending"
      meta="Your order · 2 days ago" amount="+₪3.10" amountSub="+$0.84"
    />
  </Card>
  <Button>Create link</Button>
</Screen>
```
