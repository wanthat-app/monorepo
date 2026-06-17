/**
 * Admin API — separate Lambda with its own role/exposure (ADR-0005). Admin group only;
 * read-only in MVP (audited adjustments are the only writes). Own tight IAM + DB role.
 *
 * Stub.
 */
export const handler = async (): Promise<unknown> => {
  throw new Error("not implemented");
};
