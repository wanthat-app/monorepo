import { z } from "zod";
import { IsoDateTime, PhoneE164, Uuid } from "../common";

/**
 * Admin users surface (the operator console's user management). Cognito is the customer store
 * (ADR-0006), so the whole surface — list/search, moderation, account removal — is served by the
 * non-VPC admin-credentials function: the endpoint-free VPC cannot reach cognito-idp (ADR-0004).
 * The Aurora-side DELETE /admin/users/:id survives on admin-api only until T7 drops the
 * `customer` table.
 */

/**
 * One row of GET /admin/users — Cognito attributes mapped onto the former CustomerProfile shape
 * (deliberately backward-shaped for the SPA): `id` is the Cognito sub (the canonical member id,
 * ADR-0020), `status` is derived from `Enabled` (disabled = suspended), `createdAt`/`updatedAt`
 * from `UserCreateDate`/`UserLastModifiedDate`. Differences from CustomerProfile: names may be
 * empty strings (the pool keeps given_name/family_name optional), and `userStatus` adds Cognito's
 * lifecycle state (CONFIRMED / UNCONFIRMED / ...), which SQL rows never had.
 */
export const AdminUserItem = z.object({
  id: Uuid, // Cognito sub
  phone: PhoneE164,
  email: z.string().email().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  locale: z.string(), // BCP-47; pool attribute `locale`, defaulted when unset
  status: z.enum(["active", "suspended"]), // Enabled=true / Enabled=false
  /** Cognito lifecycle state (`UserStatus`): CONFIRMED, UNCONFIRMED, EXTERNAL_PROVIDER, ... */
  userStatus: z.string().optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AdminUserItem = z.infer<typeof AdminUserItem>;

/**
 * Query for GET /admin/users. Cognito `ListUsers` replaces the SQL read (ADR-0006): pagination is
 * an opaque forward-only token (no random-access `page`), `search` is an E.164 phone PREFIX
 * (mapped to `phone_number ^= "..."` — Cognito filters one attribute, exact/prefix only; the old
 * substring-over-phone-or-email search is gone), and `pageSize` is capped at Cognito's Limit
 * maximum of 60 (was 100 under SQL paging).
 */
export const ListUsersQuery = z.object({
  search: z.string().trim().max(100).optional(),
  pageSize: z.coerce.number().int().min(1).max(60).default(20),
  /** Cognito PaginationToken from the previous response; absent = first page. */
  nextToken: z.string().max(4096).optional(),
});
export type ListUsersQuery = z.infer<typeof ListUsersQuery>;

export const ListUsersResponse = z.object({
  users: z.array(AdminUserItem),
  /**
   * `DescribeUserPool.EstimatedNumberOfUsers` — the WHOLE pool, approximate, regardless of any
   * `search` filter (Cognito has no exact or filtered count). Kept so the response stays
   * backward-shaped; `approximate: true` flags the semantics change. Do not derive page counts
   * from it — page with `nextToken`.
   */
  total: z.number().int().min(0),
  approximate: z.literal(true),
  /** Present while more pages exist; echo it back as `?nextToken=` for the next page. */
  nextToken: z.string().optional(),
});
export type ListUsersResponse = z.infer<typeof ListUsersResponse>;

/**
 * DELETE /admin/users/:id — the Aurora-side hard delete (refused 409 `has_wallet_history` while
 * any wallet_entry references the customer). Removed in T7 with the `customer` table; until then
 * the SPA still runs it before the Cognito cleanup.
 */
export const DeleteUserResponse = z.object({
  deleted: z.literal(true),
  id: Uuid,
  phone: PhoneE164,
});
export type DeleteUserResponse = z.infer<typeof DeleteUserResponse>;

/**
 * POST /admin/users/cognito-delete (admin-credentials, non-VPC) — remove the Cognito account AND
 * the member's DynamoDB recommendations (ADR-0006 decision 8): the sub is resolved via
 * `AdminGetUser` before `AdminDeleteUser`, then `deleteByOwner(sub)` erases the recs with exact
 * counter decrements.
 */
export const CognitoDeleteUserBody = z.object({
  phone: PhoneE164,
});
export type CognitoDeleteUserBody = z.infer<typeof CognitoDeleteUserBody>;

export const CognitoDeleteUserResponse = z.object({
  ok: z.literal(true),
  // false when the Cognito account was already gone (idempotent retry) — not an error.
  existed: z.boolean(),
  /** How many recommendations were erased; absent when the account was already gone. */
  recommendationsDeleted: z.number().int().min(0).optional(),
});
export type CognitoDeleteUserResponse = z.infer<typeof CognitoDeleteUserResponse>;

/**
 * Ban tooling (ADR-0006 decision 8): suspend = disable (reversible), kick = global sign-out,
 * erase = the delete above. Users are identified by phone, matching `CognitoDeleteUserBody`:
 * phone is the pool's username, so it maps 1:1 onto the `Username` parameter of
 * `AdminDisableUser` / `AdminEnableUser` / `AdminUserGlobalSignOut`. An unknown phone is a
 * plain 404 `not_found`; re-disabling a disabled user (or re-enabling an enabled one) is
 * idempotent success in Cognito, not an error.
 */

/**
 * POST /admin/users/disable — `AdminDisableUser`: reversible suspension. Profile, sub, and
 * passkeys are preserved; sign-in and token refresh stop immediately. Caveat (ADR-0006):
 * the API Gateway JWT authorizer validates statelessly, so already-issued access tokens
 * keep passing until expiry — pair with global sign-out for a full kick.
 */
export const DisableUserBody = z.object({
  phone: PhoneE164,
});
export type DisableUserBody = z.infer<typeof DisableUserBody>;

export const DisableUserResponse = z.object({
  ok: z.literal(true),
});
export type DisableUserResponse = z.infer<typeof DisableUserResponse>;

/** POST /admin/users/enable — `AdminEnableUser`: lift a suspension. */
export const EnableUserBody = z.object({
  phone: PhoneE164,
});
export type EnableUserBody = z.infer<typeof EnableUserBody>;

export const EnableUserResponse = z.object({
  ok: z.literal(true),
});
export type EnableUserResponse = z.infer<typeof EnableUserResponse>;

/**
 * POST /admin/users/global-signout — `AdminUserGlobalSignOut`: revoke every refresh token.
 * Same stateless-authorizer caveat as disable: issued access tokens live out their hour.
 */
export const GlobalSignOutUserBody = z.object({
  phone: PhoneE164,
});
export type GlobalSignOutUserBody = z.infer<typeof GlobalSignOutUserBody>;

export const GlobalSignOutUserResponse = z.object({
  ok: z.literal(true),
});
export type GlobalSignOutUserResponse = z.infer<typeof GlobalSignOutUserResponse>;
