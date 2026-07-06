/**
 * Landing service (ADR-0001, ADR-0007, ADR-0018/0019). Cookieless; behind CloudFront `/p/*`. The
 * landing is a DYNAMIC SPA page — this service only server-renders the bot-facing bits: it fetches the
 * SPA's `index.html` shell, injects per-product Open Graph tags + a product snapshot, and returns it.
 * Bots get a rich preview; humans get the shell, the SPA boots, and `SharedProductPage` runs the real
 * session + passkey mechanism at `/p/{id}`.
 *
 * MOCK phase: the product is hardcoded (design handoff); the DynamoDB resolve + real redirect land with
 * the full-landing slice. The funnel impression is emitted (structured console.log → Firehose).
 */
import { injectLanding, MOCK_PRODUCT, pickLocale } from "./landing-page";

const SERVICE = "landing";

interface LandingEvent {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: { http?: { path?: string } };
}

interface LandingResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** The SPA shell (index.html), cached briefly so a redeploy's new asset hashes are picked up. */
let shellCache: { html: string; at: number } | undefined;
const SHELL_TTL_MS = 30_000;

async function fetchShell(origin: string): Promise<string> {
  const now = Date.now();
  if (shellCache && now - shellCache.at < SHELL_TTL_MS) return shellCache.html;
  const res = await fetch(`${origin}/index.html`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`shell fetch ${res.status}`);
  const html = await res.text();
  shellCache = { html, at: now };
  return html;
}

function recIdFromPath(path: string): string | null {
  const m = path.match(/^\/p\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

export const handler = async (event: LandingEvent): Promise<LandingResult> => {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  const recId = recIdFromPath(path);
  if (!recId) {
    return {
      statusCode: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "not_found", service: SERVICE }),
    };
  }

  const headers = event.headers ?? {};
  // Absolute OG URLs + the shell fetch use the real site origin (behind CloudFront the Host header is
  // the API-Gateway domain, so prefer SITE_ORIGIN).
  const host = headers.host ?? headers.Host ?? "dev.wanthat.app";
  const proto = headers["x-forwarded-proto"] ?? "https";
  const origin = process.env.SITE_ORIGIN ?? `${proto}://${host}`;
  const locale = pickLocale(
    event.queryStringParameters?.lang ?? undefined,
    headers["accept-language"] ?? headers["Accept-Language"] ?? undefined,
  );

  console.log(JSON.stringify({ event: "landing_impression", recId, locale, service: SERVICE }));

  try {
    const shell = await fetchShell(origin);
    const html = injectLanding(shell, MOCK_PRODUCT, origin, recId, locale);
    return {
      statusCode: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Short CDN cache; the SPA-deploy CloudFront invalidation also clears it, so asset hashes stay fresh.
        "cache-control": "public, max-age=60",
      },
      body: html,
    };
  } catch (err) {
    console.error("landing_shell_error", String(err));
    return {
      statusCode: 502,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "shell_unavailable", service: SERVICE }),
    };
  }
};
