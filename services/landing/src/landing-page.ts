/**
 * Referral landing rendering (ADR-0007/0007/0018). The landing is a DYNAMIC SPA page (`/p/{id}`,
 * `SharedProductPage`) — it runs the same session + passkey mechanism as the rest of the app. The only
 * thing this service must server-render is the bot-facing content: real Open Graph tags + a product
 * snapshot injected into the SPA shell, so a shared link previews richly for crawlers. Humans get the
 * shell, the SPA boots, and the React page takes over.
 *
 * MOCK phase: the product is hardcoded from the design handoff (the DynamoDB recommendation resolve +
 * the real attributed redirect land with the full-landing slice).
 */

export type Locale = "he" | "en";

export interface LandingProduct {
  title: string;
  priceIls: string;
  cashbackIls: string;
  merchant: string;
  imagePath: string; // served by the SPA origin (same domain) — a bot-fetchable absolute URL for OG
}

export const MOCK_PRODUCT: LandingProduct = {
  title: "Jebao Smart Aquarium Fish Feeder",
  priceIls: "₪95.21",
  cashbackIls: "₪12.40",
  merchant: "AliExpress",
  imagePath: "/product-feeder.jpg",
};

const OG_DESC: Record<Locale, string> = {
  he: "קנו את המוצר הזה ב-{merchant} וקבלו {cashback} קאשבק עם wanthat.",
  en: "Buy this on {merchant} and earn {cashback} cashback with wanthat.",
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

/** The Open Graph / Twitter meta block + a matching <title>, absolute URLs from `origin`. */
export function ogHead(
  product: LandingProduct,
  origin: string,
  recId: string,
  locale: Locale,
): string {
  const desc = OG_DESC[locale]
    .replace("{merchant}", product.merchant)
    .replace("{cashback}", product.cashbackIls);
  const imageUrl = `${origin}${product.imagePath}`;
  const pageUrl = `${origin}/p/${encodeURIComponent(recId)}`;
  return [
    `<title>${esc(product.title)} · wanthat</title>`,
    `<meta name="description" content="${esc(desc)}" />`,
    `<meta property="og:type" content="product" />`,
    `<meta property="og:site_name" content="wanthat" />`,
    `<meta property="og:title" content="${esc(product.title)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`,
    `<meta property="og:image" content="${esc(imageUrl)}" />`,
    `<meta property="og:url" content="${esc(pageUrl)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(product.title)}" />`,
    `<meta name="twitter:description" content="${esc(desc)}" />`,
    `<meta name="twitter:image" content="${esc(imageUrl)}" />`,
  ].join("\n");
}

/** A minimal product snapshot rendered into #root for bots that read the body (the SPA replaces it). */
function botSnapshot(product: LandingProduct): string {
  return (
    `<div style="max-width:440px;margin:24px auto;font-family:system-ui;text-align:center">` +
    `<img src="${esc(product.imagePath)}" alt="${esc(product.title)}" style="width:100%;border-radius:16px" />` +
    `<h1>${esc(product.title)}</h1>` +
    `<p>${esc(product.priceIls)} on ${esc(product.merchant)} · earn ${esc(product.cashbackIls)} cashback</p>` +
    `</div>`
  );
}

/**
 * Inject the OG head + bot snapshot into the SPA's `index.html` shell. Keeps the SPA's asset tags
 * (hashed `<script>`/`<link>`) intact so the app boots and `SharedProductPage` takes over on `/p/{id}`.
 */
export function injectLanding(
  shell: string,
  product: LandingProduct,
  origin: string,
  recId: string,
  locale: Locale,
): string {
  const head = ogHead(product, origin, recId, locale);
  let html = shell;
  // Replace the generic <title> if present, then add the OG block before </head>.
  html = html.replace(/<title>.*?<\/title>/s, "");
  html = html.replace("</head>", `${head}\n</head>`);
  // Seed #root with a bot-readable snapshot; the SPA replaces it on mount.
  html = html.replace(/<div id="root">\s*<\/div>/, `<div id="root">${botSnapshot(product)}</div>`);
  return html;
}
