/**
 * Server-rendered referral landing (ADR-0007/0018/0019) — the entry when someone opens a shared
 * product link. It is deliberately server-rendered (not the SPA) so social/crawler bots get real
 * Open Graph tags and a rich link preview; humans get a product card + the earn pitch and are sent
 * into the REAL auth (the SPA `/auth` flow) to sign up / log in, or on to the store as a guest.
 *
 * MOCK phase: the product is hardcoded from the design handoff (the DynamoDB recommendation resolve +
 * the real affiliate redirect land with the full-landing slice). The auth it hands off to is real.
 */

export type Locale = "he" | "en";

/** The shared product (mock — design handoff `Wanthat Shared Product - Flow`). */
export interface LandingProduct {
  title: string;
  priceIls: string; // display string, ₪ leading
  cashbackIls: string;
  merchant: string;
  imagePath: string; // served by the SPA origin, same domain (bot-fetchable absolute URL for OG)
}

export const MOCK_PRODUCT: LandingProduct = {
  title: "Jebao Smart Aquarium Fish Feeder",
  priceIls: "₪95.21",
  cashbackIls: "₪12.40",
  merchant: "AliExpress",
  imagePath: "/product-feeder.jpg",
};

const COPY: Record<Locale, Record<string, string>> = {
  he: {
    dir: "rtl",
    lang: "he",
    tagline: "קאשבק אמיתי על קניות באינטרנט",
    onMerchant: "ב-{merchant}",
    earnLabel: "מקבלים בחזרה",
    earnPitch: "קונים דרך wanthat ומקבלים קאשבק אמיתי לארנק כשהעסקה מאושרת.",
    signupCta: "הרשמה וקבלת קאשבק",
    signupTrust: "חינם לגמרי · הצטרפות ב-30 שניות",
    loginCta: "כבר יש לי חשבון",
    guestCta: "המשך כאורח — בלי קאשבק",
    ogDescription: "קנו את המוצר הזה ב-{merchant} וקבלו {cashback} קאשבק עם wanthat.",
  },
  en: {
    dir: "ltr",
    lang: "en",
    tagline: "Real cashback on your online shopping",
    onMerchant: "on {merchant}",
    earnLabel: "You earn back",
    earnPitch: "Buy through wanthat and get real cashback to your wallet once the order confirms.",
    signupCta: "Sign up to earn",
    signupTrust: "Free · takes 30 seconds",
    loginCta: "I already have an account",
    guestCta: "Continue as guest — no cashback",
    ogDescription: "Buy this on {merchant} and earn {cashback} cashback with wanthat.",
  },
};

const fill = (s: string, p: LandingProduct) =>
  s.replace("{merchant}", p.merchant).replace("{cashback}", p.cashbackIls);

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Pick the render locale from an optional `?lang` then Accept-Language; default Hebrew (design default). */
export function pickLocale(lang: string | undefined, acceptLanguage: string | undefined): Locale {
  const explicit = (lang ?? "").toLowerCase();
  if (explicit.startsWith("en")) return "en";
  if (explicit.startsWith("he")) return "he";
  return (acceptLanguage ?? "").toLowerCase().startsWith("en") ? "en" : "he";
}

/**
 * Render the full landing HTML. `origin` is the request's scheme+host (for absolute OG URLs); `recId`
 * is the shared recommendation id (used only for the funnel + the post-auth `next` in this mock).
 */
export function renderLanding(args: {
  product: LandingProduct;
  locale: Locale;
  origin: string;
  recId: string;
}): string {
  const { product: p, locale, origin, recId } = args;
  const t = (k: string) => fill(COPY[locale][k] ?? k, p);
  const imageUrl = `${origin}${p.imagePath}`;
  const pageUrl = `${origin}/p/${encodeURIComponent(recId)}`;
  // After auth, return to the mock store interstitial (an SPA route). `next` is an internal path only.
  const next = encodeURIComponent(`/go/${encodeURIComponent(recId)}`);
  const ogDesc = t("ogDescription");
  const isRtl = locale === "he";

  return `<!doctype html>
<html lang="${COPY[locale].lang}" dir="${COPY[locale].dir}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(p.title)} · wanthat</title>
<meta name="description" content="${esc(ogDesc)}" />
<meta property="og:type" content="product" />
<meta property="og:site_name" content="wanthat" />
<meta property="og:title" content="${esc(p.title)}" />
<meta property="og:description" content="${esc(ogDesc)}" />
<meta property="og:image" content="${esc(imageUrl)}" />
<meta property="og:url" content="${esc(pageUrl)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(p.title)}" />
<meta name="twitter:description" content="${esc(ogDesc)}" />
<meta name="twitter:image" content="${esc(imageUrl)}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=Heebo:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  :root{--bg:#e9edeb;--surface:#fff;--ink:#15201c;--muted:#6b7b73;--line:#e6ebe8;--accent:#1f7a57;--accent-soft:#e7f1ec;--accent-soft-border:#d2e3d9}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:${isRtl ? '"Heebo"' : '"Hanken Grotesk"'},system-ui,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5}
  .wrap{max-width:440px;margin:0 auto;min-height:100dvh;display:flex;flex-direction:column;padding:24px 20px 32px}
  .brand{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:22px;letter-spacing:-0.03em;color:var(--ink);text-align:center;margin-bottom:6px}
  .tagline{color:var(--muted);font-size:13.5px;text-align:center;margin-bottom:22px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:20px;overflow:hidden;box-shadow:0 1px 2px rgba(21,32,28,.04)}
  .photo{width:100%;aspect-ratio:16/10;object-fit:cover;display:block;background:var(--accent-soft)}
  .body{padding:18px 18px 20px}
  .title{font-family:"Space Grotesk",sans-serif;font-weight:600;font-size:19px;letter-spacing:-0.02em;margin:0 0 6px}
  .price{display:flex;align-items:baseline;gap:8px;margin-bottom:16px}
  .price b{font-size:20px}
  .price span{color:var(--muted);font-size:13px}
  .money{direction:ltr;font-variant-numeric:tabular-nums;unicode-bidi:isolate}
  .earn{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--accent-soft);border:1px solid var(--accent-soft-border);border-radius:14px;padding:12px 14px;margin-bottom:14px}
  .earn .lbl{font-size:12.5px;color:var(--accent);font-weight:600}
  .earn .amt{font-size:22px;font-weight:700;color:var(--accent)}
  .pitch{color:var(--muted);font-size:13.5px;margin:0 0 18px}
  .btn{display:block;width:100%;text-align:center;text-decoration:none;font-weight:700;font-size:15.5px;border-radius:14px;padding:15px 16px;border:1px solid transparent}
  .btn-primary{background:var(--accent);color:#fff}
  .btn-secondary{background:var(--surface);color:var(--ink);border-color:var(--line);margin-top:10px;font-weight:600}
  .trust{text-align:center;color:var(--muted);font-size:12px;margin-top:10px}
  .guest{display:block;text-align:center;color:var(--muted);font-size:13px;text-decoration:none;margin-top:18px}
  .guest:hover{color:var(--ink)}
  .spacer{flex:1}
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">wanthat</div>
    <div class="tagline">${esc(t("tagline"))}</div>
    <div class="card">
      <img class="photo" src="${esc(p.imagePath)}" alt="${esc(p.title)}" />
      <div class="body">
        <h1 class="title">${esc(p.title)}</h1>
        <div class="price">
          <b class="money">${esc(p.priceIls)}</b>
          <span>${esc(t("onMerchant"))}</span>
        </div>
        <div class="earn">
          <span class="lbl">${esc(t("earnLabel"))}</span>
          <span class="amt money">${esc(p.cashbackIls)}</span>
        </div>
        <p class="pitch">${esc(t("earnPitch"))}</p>
        <a class="btn btn-primary" href="/auth?intent=signup&next=${next}">${esc(t("signupCta"))}</a>
        <a class="btn btn-secondary" href="/auth?next=${next}">${esc(t("loginCta"))}</a>
        <div class="trust">${esc(t("signupTrust"))}</div>
      </div>
    </div>
    <div class="spacer"></div>
    <a class="guest" href="/go/${encodeURIComponent(recId)}?guest=1">${esc(t("guestCta"))}</a>
  </div>
</body>
</html>`;
}
