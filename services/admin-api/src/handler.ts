/**
 * Admin API — separate Lambda with its own role/exposure (ADR-0005). Admin group only. Mostly
 * read-only in MVP; the sanctioned writes are audited ledger adjustments and the runtime config
 * panel (GET/PATCH /admin/config — e.g. the landing countdownSeconds, RuntimeConfig in DynamoDB).
 * Own tight IAM + DB role.
 *
 * Stub.
 */
export const handler = async (): Promise<unknown> => {
  throw new Error("not implemented");
};
