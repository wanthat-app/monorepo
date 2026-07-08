import { z } from "zod";
import { PhoneE164, Uuid } from "../common";
import { CustomerProfile } from "./customer";

/**
 * Admin users surface (the operator console's user management). Listing and the DB-side delete are
 * served by admin-api (in-VPC, Aurora); the Cognito account cleanup is a separate call served by the
 * non-VPC admin-credentials function, because the endpoint-free VPC cannot reach cognito-idp
 * (ADR-0004). The SPA orchestrates the two: DB delete first (it owns the wallet-history guard),
 * Cognito cleanup second — a failed cleanup leaves only a phone number in Cognito, which the
 * idempotent registration flow reuses on a later sign-up.
 */

/** Query for GET /admin/users — 1-based paging, free-text search over phone and email. */
export const ListUsersQuery = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListUsersQuery = z.infer<typeof ListUsersQuery>;

export const ListUsersResponse = z.object({
  users: z.array(CustomerProfile),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ListUsersResponse = z.infer<typeof ListUsersResponse>;

/**
 * DELETE /admin/users/:id — hard delete, refused with 409 `has_wallet_history` while any
 * wallet_entry references the customer (the append-only ledger is never orphaned or cascaded).
 * Returns the deleted row's phone so the caller can run the Cognito cleanup step.
 */
export const DeleteUserResponse = z.object({
  deleted: z.literal(true),
  id: Uuid,
  phone: PhoneE164,
});
export type DeleteUserResponse = z.infer<typeof DeleteUserResponse>;

/** POST /admin/users/cognito-delete (admin-credentials, non-VPC) — remove the Cognito account. */
export const CognitoDeleteUserBody = z.object({
  phone: PhoneE164,
});
export type CognitoDeleteUserBody = z.infer<typeof CognitoDeleteUserBody>;

export const CognitoDeleteUserResponse = z.object({
  ok: z.literal(true),
  // false when the Cognito account was already gone (idempotent retry) — not an error.
  existed: z.boolean(),
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
