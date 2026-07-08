import { type ParsedProductUrl, parseAliExpressProductUrl } from "./url";

/**
 * Share short-link expansion (`a.aliexpress.com/_x…` → the product id). This is the ONE place
 * a pasted URL is ever fetched, and it runs only in the retailer-proxy (the sole egress,
 * ADR-0004) under a strict posture that keeps the SDD §8.5 SSRF rule intact in spirit:
 *
 * - every hop's host must be on the AliExpress allow-list — the fetch target is pinned to
 *   AliExpress-controlled DNS, never an attacker-chosen host;
 * - redirects are followed MANUALLY and only the Location header is read — response bodies are
 *   never consumed;
 * - bounded hops + a per-hop timeout.
 *
 * The product id is taken from the first hop whose URL parses as a product URL — directly
 * (`…/item/{id}.html`) or embedded in a query param (the share interstitial carries the target
 * as `…share.htm?…&url=https%3A%2F%2Fwww.aliexpress.com%2Fitem%2F…`).
 */

const HOP_DOMAINS = ["aliexpress.com", "aliexpress.us"];

export interface ExpandedShortLink extends ParsedProductUrl {
  /** Normalised item URL — what link.generate receives as source_values. */
  canonicalUrl: string;
}

function hopAllowed(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return HOP_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function productFrom(url: URL): ParsedProductUrl | null {
  const direct = parseAliExpressProductUrl(url.href);
  if (direct) return direct;
  for (const value of url.searchParams.values()) {
    const nested = parseAliExpressProductUrl(value);
    if (nested) return nested;
  }
  return null;
}

/**
 * Follow the short link's redirect chain until a hop reveals the product id. Null when the
 * chain dead-ends (no redirect, hop cap, off-allow-list target, no id found) — the caller
 * answers `unsupported_url`. Network errors propagate for the caller to map to a typed error.
 */
export async function expandAliExpressShortLink(
  shortUrl: string,
  fetchFn: typeof fetch = fetch,
  { maxHops = 4, timeoutMs = 3000 }: { maxHops?: number; timeoutMs?: number } = {},
): Promise<ExpandedShortLink | null> {
  let current: URL;
  try {
    current = new URL(shortUrl);
  } catch {
    return null;
  }

  for (let hop = 0; hop < maxHops; hop++) {
    if (!hopAllowed(current)) return null;
    const res = await fetchFn(current.href, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    void res.body?.cancel().catch(() => {}); // headers only — the body is never read
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return null;

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return null;
    }
    const product = productFrom(next);
    if (product) {
      return {
        ...product,
        canonicalUrl: `https://www.aliexpress.com/item/${product.storeProductId}.html`,
      };
    }
    current = next;
  }
  return null;
}
