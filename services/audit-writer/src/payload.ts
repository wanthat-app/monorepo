import type { AuditWriteRequest } from "@wanthat/contracts";

/**
 * Shape a typed audit request into the free-form jsonb that `audit_append` chains — payload
 * shaping happens HERE in TypeScript (this replaced the 0007 SQL wrapper
 * `admin_audit_config_change`, whose jsonb shape `config_changed` mirrors exactly). The shapes
 * must stay renderable by the admin activity feed (admin-api `activity.ts` lifts `type`,
 * `phone`, `firstName`/`lastName`, `email`, `actor`, `key`, `value`, `previous`).
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
      return {
        type: "user_registered",
        sub: request.sub,
        phone: request.phone,
        ...(request.firstName ? { firstName: request.firstName } : {}),
        ...(request.lastName ? { lastName: request.lastName } : {}),
        ...(request.email ? { email: request.email } : {}),
      };
    // The moderation moves share one shape: the member acted on + the acting admin.
    case "user_deleted":
    case "user_disabled":
    case "user_enabled":
    case "user_signed_out":
      return { type: request.event, sub: request.sub, actor: request.actor };
  }
}
