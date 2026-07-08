/**
 * SSRF-safe AliExpress product-URL recognition (SDD §8.5): the pasted URL is host-allow-listed
 * and **parsed only — never fetched by us**. That rules out share short-links
 * (`a.aliexpress.com/_x…`), which would need a redirect-follow to resolve; users paste the
 * product-page URL instead. Only http(s) URLs on an AliExpress storefront host with a parseable
 * numeric item id qualify.
 */

/** Registrable AliExpress storefront domains (locale subdomains like he./m./www. all match). */
const ALIEXPRESS_DOMAINS = ["aliexpress.com", "aliexpress.us"];

/** `/item/{id}.html` and the mobile-era `/i/{id}.html`, with or without the `.html` suffix. */
const ITEM_PATH = /(?:^|\/)(?:item|i)\/(\d{6,20})(?:\.html?)?(?:$|[/?#])/;

export interface ParsedProductUrl {
  storeId: "aliexpress";
  storeProductId: string;
}

/** The store's native product id from a pasted URL, or null when it is not a supported product URL. */
export function parseAliExpressProductUrl(raw: string): ParsedProductUrl | null {
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
  if (!onAliExpress) return null;
  const productId = ITEM_PATH.exec(url.pathname)?.[1];
  if (!productId) return null;
  return { storeId: "aliexpress", storeProductId: productId };
}
