/**
 * Audit-writer (compute-topology refactor) — the ONE generic append path into the hash-chained
 * Aurora `audit_log`. In-VPC, invoked directly (typed payload, no HTTP): callers pass an
 * `AuditWriteRequest` and this function shapes it (payload.ts) and chains it via `audit_append`
 * (0005, SECURITY DEFINER, advisory-lock serialized) as the `audit_writer` role, whose ONLY
 * capability is EXECUTE on that function (0008). Transactional and side-effect-free beyond the
 * append: no DynamoDB, no events. It THROWS on any failure — synchronous callers must see the
 * miss, and asynchronous callers lean on Lambda's retry.
 */
import { Logger } from "@aws-lambda-powertools/logger";
import { AuditWriteRequest } from "@wanthat/contracts";
import { appendAudit, waitForDb } from "@wanthat/db";
import { getContext } from "./context";
import { auditPayload } from "./payload";

const logger = new Logger({ serviceName: "audit-writer" });

export const handler = async (event: unknown): Promise<void> => {
  const request = AuditWriteRequest.parse(event);
  const ctx = getContext();
  // Ride out an Aurora scale-to-zero resume before the append (60s connect budget).
  await waitForDb(ctx.db);
  await appendAudit(ctx.db, auditPayload(request));
  logger.info("audit_appended", { event: request.event });
};
