import { ResolveResponse } from "@wanthat/contracts";

/**
 * The landing resolve client (ADR-0007/0008): same-origin POST to the landing service through
 * CloudFront `/p/*` — NOT the app API (no JWT authorizer; anonymous guests must reach it).
 * Identity rides in the call: a member's Bearer access token, or the guest's opaque localStorage
 * id. The endpoint answers with the attributed store URL or `authRequired`.
 */
export async function resolveRedirect(
  recommendationId: string,
  opts: { token?: string; guestId?: string },
): Promise<ResolveResponse> {
  const res = await fetch(`/p/${encodeURIComponent(recommendationId)}/resolve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify(opts.guestId ? { guestId: opts.guestId } : {}),
  });
  if (!res.ok) throw new Error(`resolve failed: ${res.status}`);
  return ResolveResponse.parse(await res.json());
}

const GUEST_ID_KEY = "wanthat.guestId";

/**
 * The guest's opaque attribution id (ADR-0008). Consent-gated by the CALLER: this is only
 * invoked from the guest CTA click, which carries the inline consent note — never on page
 * load. One id per browser, reused across links so a later signup can claim all of them.
 */
export function getOrMintGuestId(): string {
  const existing = localStorage.getItem(GUEST_ID_KEY);
  if (existing) return existing;
  const minted = crypto.randomUUID();
  localStorage.setItem(GUEST_ID_KEY, minted);
  return minted;
}
