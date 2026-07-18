import type { AuditWriteRequest } from "@wanthat/contracts";

/**
 * Shape a typed audit request into the free-form jsonb that `audit_append` chains — payload
 * shaping happens HERE in TypeScript (this replaced the 0007 SQL wrapper
 * `admin_audit_config_change`, whose jsonb shape `config_changed` mirrors exactly). The shapes
 * must stay renderable by the admin activity feed (admin-ledger-view `activity.ts` lifts
 * `type`, `sub` → `cognitoSub`, `actor`, `key`, `value`, `previous`). Member PII (phone,
 * name, email) never enters the chain — the feed resolves the sub live instead.
 */
export function auditPayload(request: AuditWriteRequest): Record<string, unknown> {
  switch (request.event) {
    case "config_changed":
      // Exactly 0007's jsonb: absent/undefined values become JSON null (SQL `to_jsonb(NULL)`
      // did the same), so the key is always present and the feed's value transition renders.
      return {
        type: "config_changed",
        key: request.key,
        value: request.value ?? null,
        previous: request.previous ?? null,
        actor: request.actor,
      };
    case "user_registered":
      // PII-free (2026-07-18): the chain is unrewritable, so only the sub goes in — the
      // admin feed resolves it to a live profile via the users API.
      return { type: "user_registered", sub: request.sub };
    // The moderation moves share one shape: the member acted on + the acting admin.
    case "user_deleted":
    case "user_disabled":
    case "user_enabled":
    case "user_signed_out":
      return { type: request.event, sub: request.sub, actor: request.actor };
  }
}
