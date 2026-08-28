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
  // Ride out an Aurora scale-to-zero resume before the append. Bounded probes (5s each, ~22s
  // total under the 30s Lambda / admin-console's 28s audit-or-fail abort) so a resuming-but-not-
  // serving cluster can't hang one probe for the whole invocation; a never-waking cluster throws
  // cleanly and the synchronous caller reports audit_failed (or async Lambda retry kicks in).
  await waitForDb(ctx.db, {
    attempts: 4,
    delayMs: 500,
    probeTimeoutMs: 5_000,
    log: (msg, fields) => logger.warn(msg, fields),
  });
  await appendAudit(ctx.db, auditPayload(request));
  logger.info("audit_appended", { event: request.event });
};
