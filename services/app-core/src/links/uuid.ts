import { createHash } from "node:crypto";

/**
 * Fixed namespace for recommendation ids. `recommendationId = uuidV5(ownerSub#storeId#productId)`
 * makes CreateRecommendation **naturally idempotent on (owner, product)** (the contract's rule):
 * a replay derives the same id and lands on the same conditional write — no idempotency table.
 * The id stays a valid, opaque-looking UUID (`RecommendationId` is `z.string().uuid()`).
 */
export const RECOMMENDATION_NAMESPACE = "c104a170-34c9-4ddb-b8ba-1ba52f21b4c8";

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

/** RFC 4122 UUIDv5 (SHA-1, name-based). */
export function uuidV5(name: string, namespace: string): string {
  const hash = createHash("sha1")
    .update(uuidBytes(namespace))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50; // version 5
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
