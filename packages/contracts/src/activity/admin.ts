import { z } from "zod";
import { OtpChannel } from "../identity/channel";

/**
 * Admin activity feed (GET /admin/activity) — one paged list, newest first, over the Aurora
 * audit_log (user_registered / user_deleted / future audited admin actions) plus, in dev only,
 * live OTP codes from the dev sink (merged into page 1 by admin-api; the sink table does not
 * exist in prod, so the otp_sent item type can never appear there).
 */

/** Query for GET /admin/activity — 1-based paging, no filters in v1. */
export const ListActivityQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListActivityQuery = z.infer<typeof ListActivityQuery>;

/**
 * One feed row. `type` is an open string: audit payloads are free-form jsonb, and unknown/future
 * types must still render (the SPA shows a generic badge with the raw type). Field presence by
 * type: user_registered/user_deleted carry phone/name/email (actor on deletions); otp_sent
 * carries phone/channel/code/expiresAt; config_changed carries key/value/previous/actor.
 */
export const ActivityItem = z.object({
  id: z.string(), // "audit_<id>" | "otp_<phone>"
  type: z.string(),
  at: z.string().datetime(),
  phone: z.string().optional(),
  name: z.string().optional(), // "First Last" when known
  email: z.string().optional(),
  actor: z.string().optional(), // user_deleted / config_changed: the acting admin
  channel: OtpChannel.optional(), // otp_sent only
  code: z.string().optional(), // otp_sent only - the dev sink code
  expiresAt: z.string().datetime().optional(), // otp_sent only
  key: z.string().optional(), // config_changed only - the runtime-config key
  value: z.unknown().optional(), // config_changed only - the value as applied (any JSON)
  previous: z.unknown().optional(), // config_changed only - the effective value before
});
export type ActivityItem = z.infer<typeof ActivityItem>;

export const ListActivityResponse = z.object({
  items: z.array(ActivityItem),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ListActivityResponse = z.infer<typeof ListActivityResponse>;
