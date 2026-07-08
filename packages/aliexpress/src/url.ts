/**
 * AliExpress URL recognition + extraction. Recognition is parse-only and host-allow-listed
 * (SDD §8.5 SSRF posture); the one sanctioned network step — expanding a share short-link —
 * lives in short-link.ts and runs ONLY in the retailer-proxy (the sole egress, ADR-0004).
 *
 * The share button emits prose + a short link ("I just found this on AliExpress: … |
 * https://a.aliexpress.com/_c3TWMcp5"), so callers extract a candidate URL from arbitrary
 * pasted text rather than requiring the paste to BE a URL.
 */

/** Registrable AliExpress storefront domains (locale subdomains like he./m./www. all match). */
const ALIEXPRESS_DOMAINS = ["aliexpress.com", "aliexpress.us"];

/** `/item/{id}.html` and the mobile-era `/i/{id}.html`, with or without the `.html` suffix. */
const ITEM_PATH = /(?:^|\/)(?:item|i)\/(\d{6,20})(?:\.html?)?(?:$|[/?#])/;

/** URLs inside free text; trailing sentence punctuation is stripped from each match. */
const URL_IN_TEXT = /https?:\/\/\S+/g;
const TRAILING_PUNCTUATION = /[).,!?;:'"’”]+$/;

export interface ParsedProductUrl {
  storeId: "aliexpress";
  storeProductId: string;
}

function aliExpressUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const onAliExpress = ALIEXPRESS_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  return onAliExpress ? url : null;
}

/** The store's native product id from a pasted URL, or null when it is not a supported product URL. */
export function parseAliExpressProductUrl(raw: string): ParsedProductUrl | null {
  const url = aliExpressUrl(raw);
  if (!url) return null;
  const productId = ITEM_PATH.exec(url.pathname)?.[1];
  if (!productId) return null;
  return { storeId: "aliexpress", storeProductId: productId };
}

/**
 * A share-button short link (`https://a.aliexpress.com/_c3TWMcp5`). Recognised here; resolved
 * to a product only by the retailer-proxy's expansion step (short-link.ts).
 */
export function isAliExpressShortLink(raw: string): boolean {
  const url = aliExpressUrl(raw);
  return (
    url !== null &&
    url.hostname.toLowerCase() === "a.aliexpress.com" &&
    /^\/_[A-Za-z0-9]+$/.test(url.pathname)
  );
}

export type AliExpressCandidate =
  | ({ kind: "product"; url: string } & ParsedProductUrl)
  | { kind: "shortLink"; url: string };

/**
 * The first supported AliExpress URL found in arbitrary pasted text (the share-button message,
 * a bare URL, prose around a link…): either a directly-parseable product URL or a share
 * short-link that the retailer-proxy can expand. Null when the text carries neither.
 */
export function extractAliExpressUrl(text: string): AliExpressCandidate | null {
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, "");
    const product = parseAliExpressProductUrl(candidate);
    if (product) return { kind: "product", url: candidate, ...product };
    if (isAliExpressShortLink(candidate)) return { kind: "shortLink", url: candidate };
  }
  return null;
}
