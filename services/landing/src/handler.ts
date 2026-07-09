/**
 * Landing service (ADR-0001, ADR-0007). Cookieless; behind CloudFront `/p/*`. Resolves the
 * recommendation projection in ONE DynamoDB lookup, then serves the SPA shell with three
 * injections: real OG/Twitter tags, a server-rendered content-first product card in `#root`,
 * and the `window.__WANTHAT_LANDING__` snapshot (`LandingSnapshot`) the SPA hydrates from.
 * Humans see the product before any JS runs; the SPA boots and `SharedProductPage` runs the
 * session/passkey/guest mechanism client-side (identity never resolves on this server).
 *
 * A snapshot is ALWAYS injected — not-found and read failures serve `{status:"notFound"}` with
 * a 200 (a real 404 would be swallowed by CloudFront's SPA-routing 404→index.html rewrite, and
 * the SPA hard-reloads when a snapshot is missing, so an omitted one would loop).
 */
import { ImpressionEvent, LandingSnapshot } from "@wanthat/contracts";
import { buildEstimate } from "@wanthat/domain";
import { getContext } from "./context";
import { buildRender, injectLanding, type LandingRender, pickLocale } from "./landing-page";
import { resolve, verifyBearer } from "./resolve";

const SERVICE = "landing";

interface LandingEvent {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: { http?: { path?: string; method?: string } };
  body?: string;
  isBase64Encoded?: boolean;
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

/**
 * Admin-tunable knobs, cached briefly: an admin edit (runtime-config panel) takes effect within
 * ~30s without redeploy, while the hot path pays the config reads only once per TTL.
 */
let cfgCache: { countdownSeconds: number; fxCommissionBps: number; at: number } | undefined;
const CFG_TTL_MS = 30_000;

async function getCfg(): Promise<{ countdownSeconds: number; fxCommissionBps: number }> {
  const now = Date.now();
  if (cfgCache && now - cfgCache.at < CFG_TTL_MS) return cfgCache;
  const ctx = getContext();
  const [countdownSeconds, fxCommissionBps] = await Promise.all([
    ctx.config.get("landing.countdownSeconds"),
    ctx.config.get("fx.conversionCommissionBps"),
  ]);
  cfgCache = {
    countdownSeconds: Number(countdownSeconds),
    fxCommissionBps: Number(fxCommissionBps),
    at: now,
  };
  return cfgCache;
}

/** Test seam: the module-level caches survive across invocations by design. */
export function resetCachesForTests(): void {
  shellCache = undefined;
  cfgCache = undefined;
}

function recIdFromPath(path: string): string | null {
  const m = path.match(/^\/p\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

export const handler = async (event: LandingEvent): Promise<LandingResult> => {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";

  // POST /p/{id}/resolve — the client-driven attributed redirect (ADR-0007/0008).
  const resolveMatch = path.match(/^\/p\/([^/?#]+)\/resolve$/);
  if (resolveMatch?.[1]) {
    const method = event.requestContext?.http?.method ?? "GET";
    if (method !== "POST") {
      return {
        statusCode: 405,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "method_not_allowed", service: SERVICE }),
      };
    }
    return resolve(event, decodeURIComponent(resolveMatch[1]), {
      recommendations: getContext().recommendations,
      verifyBearer,
    });
  }

  const recId = recIdFromPath(path);
  if (!recId) {
    return {
      statusCode: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "not_found", service: SERVICE }),
    };
  }

  const headers = event.headers ?? {};
  // The site origin MUST come from config, NEVER the request. It drives both the shell fetch and the
  // absolute OG URLs, so a request-derived (Host header) origin would be an SSRF + cache-poisoning
  // vector: an attacker could point the fetch at their own HTML and have CloudFront cache it.
  const origin = process.env.SITE_ORIGIN;
  if (!origin || !/^https:\/\/[a-z0-9.-]+$/i.test(origin)) {
    console.error("landing_config_error", "SITE_ORIGIN missing or malformed");
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "misconfigured", service: SERVICE }),
    };
  }
  const locale = pickLocale(
    event.queryStringParameters?.lang ?? undefined,
    headers["accept-language"] ?? headers["Accept-Language"] ?? undefined,
  );

  // ONE DynamoDB lookup (ADR-0007). Any resolve failure degrades to the notFound snapshot — the
  // page still serves, the SPA renders its not-found state, and nothing user-facing 5xxes.
  let render: LandingRender | null = null;
  let snapshot: unknown = { status: "notFound" };
  try {
    const item = await getContext().recommendations.get(recId);
    if (item) {
      const cfg = await getCfg();
      const fxRate =
        item.price && item.price.currency !== "ILS"
          ? await getContext().fx.get(item.price.currency, "ILS")
          : undefined;
      render = buildRender(item, fxRate?.rate ?? null, cfg.fxCommissionBps);
      snapshot = {
        status: "ok",
        landing: {
          recommendationId: item.recommendationId,
          product: {
            storeId: item.storeId,
            storeProductId: item.storeProductId,
            title: item.title,
            imageUrl: item.imageUrl,
            price: item.price,
            commissionBps: item.commissionBps,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          },
          review: item.review ?? null,
          estimate: buildEstimate(item.price, item.commissionBps, item.cashback),
          referrerFirstName: item.referrerFirstName,
        },
        countdownSeconds: cfg.countdownSeconds,
        displayFx: fxRate ? { rate: fxRate, commissionBps: cfg.fxCommissionBps } : null,
      };
      // Funnel impression (ADR-0007): a structured line the Logs→Firehose subscription ships.
      console.log(
        JSON.stringify(
          ImpressionEvent.parse({
            type: "impression",
            recommendationId: item.recommendationId,
            at: new Date().toISOString(),
          }),
        ),
      );
    }
  } catch (err) {
    console.error("landing_resolve_error", String(err));
    render = null;
    snapshot = { status: "notFound" };
  }

  // Contract-validate, then wire-serialise (Money bigint → decimal string) and `<`-escape so
  // stored content can never close the script tag.
  const snapshotJson = JSON.stringify(LandingSnapshot.parse(snapshot), (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  ).replace(/</g, "\\u003c");

  try {
    const shell = await fetchShell(origin);
    const html = injectLanding(shell, render, snapshotJson, origin, recId, locale);
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
