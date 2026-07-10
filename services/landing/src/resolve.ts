/**
 * Client-driven resolve — POST /p/{recommendationId}/resolve (ADR-0007/0008). The SPA calls this
 * same-origin (CloudFront `/p/*`) once it knows the consumer's identity, and the endpoint
 * assembles `custom_parameters` onto the STORED product-level affiliate URL (the env-prefixed
 * af/dp wire format — see @wanthat/domain `withAttribution`):
 *   member → Bearer access token, verified OFFLINE against cached JWKS (never a Cognito call on
 *            the hot path) → the consumer is the member's sub;
 *   guest  → opaque `guestId` from consent-gated localStorage → the consumer is the guest id;
 *   neither / invalid token → `{ outcome: "authRequired" }` (the SPA re-auths and re-resolves —
 *            never a 401, per the `ResolveResponse` contract).
 * Open-redirect safe: the URL only ever comes from the recommendation projection. Always emits
 * the click funnel event (structured console.log → Logs subscription → Firehose).
 */
import { ClickEvent, type ConsumerKind, ResolveBody, ResolveResponse } from "@wanthat/contracts";
import { type ResolvedConsumer, withAttribution } from "@wanthat/domain";
import type { RecommendationRepo } from "@wanthat/dynamo";
import { CognitoJwtVerifier } from "aws-jwt-verify";

export interface ResolveEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface ResolveDeps {
  recommendations: Pick<RecommendationRepo, "get">;
  /** Returns the verified Cognito sub, or null for a missing/invalid/expired token. */
  verifyBearer: (authorization: string | undefined) => Promise<string | null>;
  /** This deployment's env name (WANTHAT_ENV) — stamped into the click's attribution. */
  env: string;
}

interface ResolveResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const json = (statusCode: number, payload: unknown): ResolveResult => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(payload),
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

/** Lazy per-container verifier: aws-jwt-verify fetches + caches the pool JWKS across invokes. */
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

export async function verifyBearer(authorization: string | undefined): Promise<string | null> {
  if (!authorization?.toLowerCase().startsWith("bearer ")) return null;
  try {
    verifier ??= CognitoJwtVerifier.create({
      userPoolId: requireEnv("USER_POOL_ID"),
      tokenUse: "access",
      clientId: requireEnv("USER_POOL_CLIENT_ID"),
    });
    const payload = await verifier.verify(authorization.slice(7));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    // Invalid/expired token → authRequired (the SPA refreshes its session and re-resolves).
    return null;
  }
}

const emitClick = (recommendationId: string, consumer: ConsumerKind): void => {
  console.log(
    JSON.stringify(
      ClickEvent.parse({ type: "click", recommendationId, consumer, at: new Date().toISOString() }),
    ),
  );
};

export async function resolve(
  event: ResolveEvent,
  recommendationId: string,
  deps: ResolveDeps,
): Promise<ResolveResult> {
  const headers = event.headers ?? {};

  let raw: unknown = {};
  if (event.body) {
    try {
      const text = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
      raw = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid_request" });
    }
  }
  const body = ResolveBody.safeParse(raw);
  if (!body.success) return json(400, { error: "invalid_request" });

  let consumer: ResolvedConsumer | null = null;
  const sub = await deps.verifyBearer(headers.authorization ?? headers.Authorization);
  if (sub) consumer = { kind: "member", sub };
  else if (body.data.guestId) consumer = { kind: "guest", guestId: body.data.guestId };

  const rec = await deps.recommendations.get(recommendationId);
  if (!rec) return json(404, { error: "not_found" });

  if (!consumer) {
    emitClick(recommendationId, "none");
    return json(200, ResolveResponse.parse({ outcome: "authRequired" }));
  }

  const url = withAttribution(rec.affiliateUrl, {
    env: deps.env,
    referrerSub: rec.ownerId,
    recommendationId,
    consumer,
  });
  emitClick(recommendationId, consumer.kind);
  return json(200, ResolveResponse.parse({ outcome: "redirect", url }));
}
