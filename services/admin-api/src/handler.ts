/**
 * Admin API — separate Lambda with its own role/exposure (ADR-0005). Admin group only. Mostly
 * read-only in MVP; the sanctioned writes are audited ledger adjustments and the runtime config
 * panel (GET/PATCH /admin/config — e.g. the landing countdownSeconds, RuntimeConfig in DynamoDB).
 * Own tight IAM + DB role.
 *
 * Walking skeleton — returns a structured 501 so the deployed admin endpoint is reachable for the
 * pipeline smoke test. Real admin routes land later.
 */
const SERVICE = "admin-api";

export const handler = async (): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> => ({
  statusCode: 501,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ error: "not_implemented", service: SERVICE }),
});
