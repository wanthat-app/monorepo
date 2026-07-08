/**
 * Client-side pre-check that pasted text carries a supported AliExpress URL, so the create
 * screen can auto-submit on paste and reject other stores without a round-trip. Accepts both a
 * product URL and the share-button MESSAGE ("I just found this on AliExpress: … |
 * https://a.aliexpress.com/_x…") — the short link is expanded server-side. Mirrors the
 * canonical server-side extractor (`@wanthat/aliexpress` extractAliExpressUrl) — duplicated
 * here because that package's barrel pulls `node:crypto` (the signing client), which a browser
 * bundle must not import. The server re-validates; this is UX, not enforcement.
 */

const ALIEXPRESS_DOMAINS = ["aliexpress.com", "aliexpress.us"];
const ITEM_PATH = /(?:^|\/)(?:item|i)\/(\d{6,20})(?:\.html?)?(?:$|[/?#])/;
const URL_IN_TEXT = /https?:\/\/\S+/g;
const TRAILING_PUNCTUATION = /[).,!?;:'"’”]+$/;

function supportedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  const onAliExpress = ALIEXPRESS_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  if (!onAliExpress) return false;
  // A product URL, or a share short-link the server can expand.
  return (
    ITEM_PATH.test(url.pathname) ||
    (host === "a.aliexpress.com" && /^\/_[A-Za-z0-9]+$/.test(url.pathname))
  );
}

/** The first supported AliExpress URL inside arbitrary pasted text, or null. */
export function extractSupportedUrl(text: string): string | null {
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, "");
    if (supportedUrl(candidate)) return candidate;
  }
  return null;
}
