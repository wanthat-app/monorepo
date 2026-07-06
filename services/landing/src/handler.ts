/**
 * Landing service (ADR-0001, ADR-0003, ADR-0007, ADR-0008). Cookieless; behind CloudFront `/p/*` (a
 * public HTTP API, no authorizer). Serves a server-rendered, OG-tagged referral landing so shared
 * links preview richly for bots AND hand humans into the real auth (the SPA `/auth` flow).
 *
 * MOCK phase (this file): the product is hardcoded (design handoff) rather than resolved from the
 * DynamoDB recommendation, and there is no real affiliate redirect yet — but the funnel event is
 * emitted and the auth it links to is real. The DynamoDB resolve + 301 land with the full-landing slice.
 *
 * Funnel events are structured console.log lines (a CloudWatch Logs subscription ships them to
 * Firehose) — never an awaited PutRecord (Lambda freezes after the response and would drop it).
 */
import { MOCK_PRODUCT, pickLocale, renderLanding } from "./landing-page";

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

/** The recommendation id from `/p/{id}` (mock: used only for the funnel event + the post-auth path). */
function recIdFromPath(path: string): string | null {
  const m = path.match(/^\/p\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

export const handler = async (event: LandingEvent): Promise<LandingResult> => {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  const recId = recIdFromPath(path);

  // Only /p/{id} is a landing; anything else is a bad path into this service.
  if (!recId) {
    return {
      statusCode: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "not_found", service: SERVICE }),
    };
  }

  const headers = event.headers ?? {};
  // Absolute OG URLs must use the real site origin. Behind CloudFront the Host header is the
  // API-Gateway domain, so prefer the configured SITE_ORIGIN; fall back to the request host locally.
  const host = headers.host ?? headers.Host ?? "dev.wanthat.app";
  const proto = headers["x-forwarded-proto"] ?? "https";
  const origin = process.env.SITE_ORIGIN ?? `${proto}://${host}`;
  const locale = pickLocale(
    event.queryStringParameters?.lang ?? undefined,
    headers["accept-language"] ?? headers["Accept-Language"] ?? undefined,
  );

  // Funnel: impression (structured line, shipped to Firehose by a Logs subscription — not awaited).
  console.log(JSON.stringify({ event: "landing_impression", recId, locale, service: SERVICE }));

  const html = renderLanding({ product: MOCK_PRODUCT, locale, origin, recId });
  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Short CDN cache: bots re-crawl, and this is mock content that will become a real resolve.
      "cache-control": "public, max-age=60",
    },
    body: html,
  };
};
