import { createHash } from "node:crypto";

/**
 * Short recommendation id: 11 base62 chars (~64 bits), derived deterministically from
 * (owner, product) under a versioned domain prefix. Deterministic derivation is what makes
 * CreateRecommendation **naturally idempotent on (owner, product)** — a replay computes the
 * same id and lands on the same conditional write, no idempotency table. Short because the id
 * IS the share URL path (`/p/{id}`) and the attribution `ref`; 64 bits keeps the accidental
 * birthday-collision odds negligible at MVP scale, and the create path still verifies the
 * owner on a conditional-write hit, so even a collision cannot leak another member's link.
 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 11; // 62^11 > 2^64, so 8 hash bytes always fit

export function recommendationIdFor(
  ownerId: string,
  storeId: string,
  storeProductId: string,
): string {
  const digest = createHash("sha256")
    .update(`wanthat:rec:v1:${ownerId}#${storeId}#${storeProductId}`)
    .digest();
  let n = digest.readBigUInt64BE(0);
  let out = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}
