/**
 * Client-side pre-check that a pasted URL looks like a supported (AliExpress) product URL, so
 * the create screen can auto-submit on paste and reject other stores without a round-trip.
 * Mirrors the canonical server-side parser (`@wanthat/aliexpress` parseAliExpressProductUrl) —
 * duplicated here because that package's barrel pulls `node:crypto` (the signing client), which
 * a browser bundle must not import. The server re-validates; this is UX, not enforcement.
 */

const ALIEXPRESS_DOMAINS = ["aliexpress.com", "aliexpress.us"];
const ITEM_PATH = /(?:^|\/)(?:item|i)\/(\d{6,20})(?:\.html?)?(?:$|[/?#])/;

export function isSupportedProductUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  const onAliExpress = ALIEXPRESS_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  return onAliExpress && ITEM_PATH.test(url.pathname);
}

/** True once the text plausibly holds a full URL (paste target for auto-submit). */
export function looksLikeUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}
