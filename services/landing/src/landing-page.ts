/**
 * Referral landing rendering (ADR-0007). Server-renders the REAL page: Open Graph/Twitter tags
 * from the resolved recommendation, a content-first product card seeded into `#root` (visible
 * before any JS runs; bots read the same markup — no user-agent sniffing), and the
 * `window.__WANTHAT_LANDING__` snapshot (`LandingSnapshot`, @wanthat/contracts) the SPA hydrates
 * from. The SPA then mounts the identical card over this markup and adds the auth module
 * (`SharedProductPage`), so the swap is visually seamless.
 *
 * The card markup uses ONLY Tailwind classes that appear in the SPA source — the compiled CSS
 * bundle contains nothing else.
 */
import { buildEstimate, convertMinor } from "@wanthat/domain";
import type { RecommendationItem } from "@wanthat/dynamo";

export type Locale = "he" | "en";

/** Everything the server-side card + OG tags need, display-ready (converted + formatted). */
export interface LandingRender {
  title: string;
  merchant: string;
  imageUrl: string | null; // stored absolute https URL (retailer CDN)
  priceDisplay: string | null; // "₪87.50" (fx-converted) or origin-currency fallback "$25.00"
  cashbackDisplay: string | null; // consumer-side estimate, same conversion
  reviewText: string | null;
  referrerFirstName: string | null;
}

const MERCHANT_NAMES: Record<string, string> = { aliexpress: "AliExpress" };
const merchantName = (storeId: string): string => MERCHANT_NAMES[storeId] ?? storeId;

/** Mirrors the SPA's `shared.*` i18n copy (apps/web/src/i18n.ts) so server and SPA cards match. */
const COPY: Record<
  Locale,
  { on: string; earn: string; recommends: string; sentYou: string; pitch: string }
> = {
  en: {
    on: "on {merchant}",
    earn: "You earn back",
    recommends: "{name} recommends this",
    sentYou: "Someone sent you a cashback link",
    pitch: "Buy through wanthat and get real cashback to your wallet once the order confirms.",
  },
  he: {
    on: "ב-{merchant}",
    earn: "מקבלים בחזרה",
    recommends: "{name} ממליץ/ה על זה",
    sentYou: "מישהו שלח לך קישור קאשבק",
    pitch: "קונים דרך wanthat ומקבלים קאשבק אמיתי לארנק כשהעסקה מאושרת.",
  },
};

const OG_DESC: Record<Locale, string> = {
  he: "קנו את המוצר הזה ב-{merchant} וקבלו {cashback} קאשבק עם wanthat.",
  en: "Buy this on {merchant} and earn {cashback} cashback with wanthat.",
};

const OG_DESC_NO_AMOUNT: Record<Locale, string> = {
  he: "קנו את המוצר הזה ב-{merchant} עם קאשבק דרך wanthat.",
  en: "Buy this on {merchant} with cashback through wanthat.",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Pick the render locale from an optional `?lang` then Accept-Language; default Hebrew (design default). */
export function pickLocale(lang: string | undefined, acceptLanguage: string | undefined): Locale {
  const explicit = (lang ?? "").toLowerCase();
  if (explicit.startsWith("en")) return "en";
  if (explicit.startsWith("he")) return "he";
  return (acceptLanguage ?? "").toLowerCase().startsWith("en") ? "en" : "he";
}

const SYMBOLS: Record<string, string> = { ILS: "₪", USD: "$", EUR: "€", GBP: "£" };

/**
 * Minor units → display string ("8750" ILS → "₪87.50"). A ~10-line sibling of the SPA's
 * `formatMoneyMinor` (apps/web/src/lib/money.ts) — bigint/string math only, never floats.
 */
export function formatMinor(amountMinor: bigint, currency: string): string {
  const neg = amountMinor < 0n;
  const digits = (neg ? -amountMinor : amountMinor).toString().padStart(3, "0");
  const int = digits
    .slice(0, -2)
    .replace(/^0+(?=\d)/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return `${neg ? "-" : ""}${symbol}${int}.${digits.slice(-2)}`;
}

/** ILS display when a rate is cached (same convertMinor path as withdrawal); origin currency otherwise. */
function display(
  amountMinor: bigint,
  currency: string,
  fxRate: string | null,
  fxCommissionBps: number,
): string {
  if (currency !== "ILS" && fxRate) {
    return formatMinor(convertMinor(amountMinor, fxRate, fxCommissionBps), "ILS");
  }
  return formatMinor(amountMinor, currency);
}

/**
 * The stored projection → display-ready render model. Same convention as the create flow
 * (CreateLinkPage): the PRICE converts at the pure rate (information, not money we pay out),
 * while CASHBACK carries the FX conversion margin so the figure matches what a withdrawal
 * would actually yield.
 */
export function buildRender(
  item: RecommendationItem,
  fxRate: string | null,
  fxCommissionBps: number,
): LandingRender {
  const estimate = buildEstimate(item.price, item.commissionBps, item.cashback);
  const consumer = estimate.consumer.estimated;
  return {
    title: item.title,
    merchant: merchantName(item.storeId),
    imageUrl: item.imageUrl,
    priceDisplay: item.price
      ? display(BigInt(item.price.amountMinor), item.price.currency, fxRate, 0)
      : null,
    cashbackDisplay: consumer
      ? display(consumer.amountMinor, consumer.currency, fxRate, fxCommissionBps)
      : null,
    reviewText: item.review?.text ?? null,
    referrerFirstName: item.referrerFirstName,
  };
}

/** The Open Graph / Twitter meta block + a matching <title>. `og:image` is the stored absolute URL. */
export function ogHead(
  render: LandingRender,
  origin: string,
  recId: string,
  locale: Locale,
): string {
  const desc =
    render.reviewText ??
    (render.cashbackDisplay
      ? OG_DESC[locale]
          .replace("{merchant}", render.merchant)
          .replace("{cashback}", render.cashbackDisplay)
      : OG_DESC_NO_AMOUNT[locale].replace("{merchant}", render.merchant));
  const pageUrl = `${origin}/p/${encodeURIComponent(recId)}`;
  const tags = [
    `<title>${esc(render.title)} · wanthat</title>`,
    `<meta name="description" content="${esc(desc)}" />`,
    `<meta property="og:type" content="product" />`,
    `<meta property="og:site_name" content="wanthat" />`,
    `<meta property="og:title" content="${esc(render.title)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`,
    `<meta property="og:url" content="${esc(pageUrl)}" />`,
  ];
  if (render.imageUrl) {
    tags.push(
      `<meta property="og:image" content="${esc(render.imageUrl)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${esc(render.title)}" />`,
      `<meta name="twitter:description" content="${esc(desc)}" />`,
      `<meta name="twitter:image" content="${esc(render.imageUrl)}" />`,
    );
  }
  return tags.join("\n");
}

/** Head for a link that did not resolve — generic, no product leak, still branded. */
function genericHead(locale: Locale): string {
  const desc = OG_DESC_NO_AMOUNT[locale].replace("{merchant}", "AliExpress");
  return [
    `<title>wanthat</title>`,
    `<meta name="description" content="${esc(desc)}" />`,
    `<meta property="og:site_name" content="wanthat" />`,
    `<meta property="og:title" content="wanthat" />`,
  ].join("\n");
}

/**
 * The content-first card, server-rendered into #root. Mirrors `SharedProductPage`'s markup and
 * Tailwind classes so the React mount replaces it without a visual jump.
 */
function serverCard(render: LandingRender, locale: Locale): string {
  const copy = COPY[locale];
  const attribution = render.referrerFirstName
    ? copy.recommends.replace("{name}", esc(render.referrerFirstName))
    : copy.sentYou;
  const img = render.imageUrl
    ? `<img src="${esc(render.imageUrl)}" alt="${esc(render.title)}" class="aspect-[16/10] w-full bg-accent-soft object-cover" />`
    : "";
  const price = render.priceDisplay
    ? `<div class="flex items-baseline gap-2"><b class="text-[20px] tabular-nums" dir="ltr">${esc(render.priceDisplay)}</b><span class="text-[13px] text-muted">${esc(copy.on.replace("{merchant}", render.merchant))}</span></div>`
    : "";
  const cashback = render.cashbackDisplay
    ? `<div class="flex items-center justify-between rounded-[14px] border border-[#d2e3d9] bg-accent-soft px-3.5 py-3"><span class="text-[12.5px] font-semibold text-accent">${esc(copy.earn)}</span><span class="text-[22px] font-bold tabular-nums text-accent" dir="ltr">${esc(render.cashbackDisplay)}</span></div>`
    : "";
  const review = render.reviewText
    ? `<p class="text-[13.5px]">"${esc(render.reviewText)}"</p>`
    : "";
  return (
    `<div class="mx-auto flex w-full max-w-[440px] flex-col gap-4">` +
    `<div class="text-center font-display text-[22px] font-bold tracking-[-0.03em]">wanthat</div>` +
    `<div class="overflow-hidden rounded-[20px] border border-line bg-surface">` +
    img +
    `<div class="flex flex-col gap-3 p-[18px]">` +
    `<p class="text-[13px] text-muted">${attribution}</p>` +
    `<h1 class="font-display text-[19px] font-semibold tracking-[-0.02em]">${esc(render.title)}</h1>` +
    price +
    cashback +
    review +
    `<p class="text-[13.5px] text-muted">${esc(copy.pitch)}</p>` +
    `</div></div></div>`
  );
}

/**
 * Inject the OG head, the snapshot script, and the server card into the SPA's `index.html`
 * shell. Keeps the SPA's asset tags (hashed `<script>`/`<link>`) intact so the app boots and
 * `SharedProductPage` takes over on `/p/{id}`. `snapshotJson` MUST already have `<` escaped
 * (as <) so stored content can never break out of the script tag.
 */
export function injectLanding(
  shell: string,
  render: LandingRender | null,
  snapshotJson: string,
  origin: string,
  recId: string,
  locale: Locale,
): string {
  const head = render ? ogHead(render, origin, recId, locale) : genericHead(locale);
  let html = shell;
  html = html.replace(/<title>.*?<\/title>/s, "");
  html = html.replace(
    "</head>",
    `${head}\n<script>window.__WANTHAT_LANDING__ = ${snapshotJson};</script>\n</head>`,
  );
  html = html.replace(
    /<div id="root">\s*<\/div>/,
    `<div id="root">${render ? serverCard(render, locale) : ""}</div>`,
  );
  return html;
}
