import { z } from "zod";
import { PhoneE164, Uuid } from "../common";

/**
 * Invoke payload of the audit-writer Lambda — the ONE generic append path into the hash-chained
 * Aurora `audit_log` (0005 `audit_append`, SECURITY DEFINER, advisory-lock serialized). Payload
 * shaping to the audit jsonb happens in the audit-writer in TypeScript (it replaced the narrow
 * SQL wrapper `admin_audit_config_change` of 0007), so the jsonb shapes MUST stay compatible
 * with what the admin activity feed already renders (admin-api `activity.ts`):
 * `config_changed` chains `{type, key, value, previous, actor}` exactly as 0007 did, and
 * `user_registered` keeps the `phone`/`firstName`/`lastName`/`email` keys the feed lifts.
 */

/** The acting admin — email from the ID-token claims, falling back to username/sub. */
const Actor = z.string().min(1);

/** A runtime-config edit (formerly the 0007 SQL wrapper). `value`/`previous` are free JSON. */
export const ConfigChangedAudit = z.object({
  event: z.literal("config_changed"),
  key: z.string().min(1),
  value: z.unknown(),
  previous: z.unknown(),
  actor: Actor,
});
export type ConfigChangedAudit = z.infer<typeof ConfigChangedAudit>;

/** A confirmed member signup (Cognito is the user store; `sub` is canonical, ADR-0020). */
export const UserRegisteredAudit = z.object({
  event: z.literal("user_registered"),
  sub: Uuid,
  phone: PhoneE164,
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
});
export type UserRegisteredAudit = z.infer<typeof UserRegisteredAudit>;

/** An admin moderation move on a member account (delete / disable / enable / global sign-out). */
const moderation = <T extends string>(event: T) =>
  z.object({ event: z.literal(event), sub: Uuid, actor: Actor });

export const UserDeletedAudit = moderation("user_deleted");
export type UserDeletedAudit = z.infer<typeof UserDeletedAudit>;
export const UserDisabledAudit = moderation("user_disabled");
export type UserDisabledAudit = z.infer<typeof UserDisabledAudit>;
export const UserEnabledAudit = moderation("user_enabled");
export type UserEnabledAudit = z.infer<typeof UserEnabledAudit>;
export const UserSignedOutAudit = moderation("user_signed_out");
export type UserSignedOutAudit = z.infer<typeof UserSignedOutAudit>;

/** The audit-writer invoke payload — a discriminated union over `event`. */
export const AuditWriteRequest = z.discriminatedUnion("event", [
  ConfigChangedAudit,
  UserRegisteredAudit,
  UserDeletedAudit,
  UserDisabledAudit,
  UserEnabledAudit,
  UserSignedOutAudit,
]);
export type AuditWriteRequest = z.infer<typeof AuditWriteRequest>;
