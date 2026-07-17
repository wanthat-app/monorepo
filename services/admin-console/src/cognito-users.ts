import {
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  type AdminGetUserCommandOutput,
  AdminUserGlobalSignOutCommand,
  type CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  ListUsersCommand,
  UserNotFoundException,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { AdminUserItem } from "@wanthat/contracts";

/**
 * Customer-pool user management for the admin users page (ADR-0006 decision 8). Runs here
 * (non-VPC) because the endpoint-free VPC cannot reach cognito-idp (ADR-0004). Username is the
 * phone throughout (phone-as-username): list/search via `ListUsers`, suspend/lift/kick via the
 * Admin lifecycle calls, erasure via `AdminGetUser` (sub resolution for the recommendation
 * cleanup) + `AdminDeleteUser`.
 */

/**
 * Map one Cognito `ListUsers` entry onto the contract row (PURE, exported for tests). Users the
 * mapping cannot represent (no sub, no phone, malformed email) are skipped rather than failing
 * the whole page - `undefined` here means "drop the row".
 */
export function toAdminUserItem(user: UserType): AdminUserItem | undefined {
  const attrs = new Map((user.Attributes ?? []).map((a) => [a.Name, a.Value]));
  const createdAt = user.UserCreateDate?.toISOString();
  const parsed = AdminUserItem.safeParse({
    id: attrs.get("sub"),
    phone: attrs.get("phone_number"),
    email: attrs.get("email") ?? null,
    // The pool keeps the name attributes optional (T1) - absent maps to the empty string.
    firstName: attrs.get("given_name") ?? "",
    lastName: attrs.get("family_name") ?? "",
    locale: attrs.get("locale") ?? "he-IL",
    status: user.Enabled === false ? "suspended" : "active",
    ...(user.UserStatus ? { userStatus: user.UserStatus } : {}),
    createdAt,
    updatedAt: user.UserLastModifiedDate?.toISOString() ?? createdAt,
  });
  return parsed.success ? parsed.data : undefined;
}

/** The member's canonical id (Cognito sub, ADR-0020) from an AdminGetUser result, spread-ready. */
function subOf(user: AdminGetUserCommandOutput): { sub?: string } {
  const sub = user.UserAttributes?.find((a) => a.Name === "sub")?.Value;
  return sub ? { sub } : {};
}

export interface ListUsersPage {
  users: AdminUserItem[];
  /** DescribeUserPool.EstimatedNumberOfUsers - the whole pool, approximate (never filtered). */
  total: number;
  approximate: true;
  nextToken?: string;
}

export class CognitoUserAdmin {
  constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly userPoolId: string,
  ) {}

  /**
   * One page of the users list. `phonePrefix` becomes the pool filter `phone_number ^= "..."`
   * (Cognito filters ONE attribute, exact or prefix - ADR-0006 consequence); pagination is the
   * opaque forward-only `PaginationToken`. The approximate pool total rides along from
   * `DescribeUserPool` so the response stays backward-shaped for the SPA.
   */
  async list(opts: {
    phonePrefix?: string;
    limit: number;
    nextToken?: string;
  }): Promise<ListUsersPage> {
    // The filter value sits inside a quoted string - strip quote/backslash rather than escaping
    // (neither can appear in an E.164 prefix anyway).
    const prefix = opts.phonePrefix?.replace(/["\\]/g, "");
    const [page, described] = await Promise.all([
      this.client.send(
        new ListUsersCommand({
          UserPoolId: this.userPoolId,
          Limit: opts.limit,
          ...(opts.nextToken ? { PaginationToken: opts.nextToken } : {}),
          ...(prefix ? { Filter: `phone_number ^= "${prefix}"` } : {}),
        }),
      ),
      this.client.send(new DescribeUserPoolCommand({ UserPoolId: this.userPoolId })),
    ]);
    return {
      users: (page.Users ?? [])
        .map(toAdminUserItem)
        .filter((u): u is AdminUserItem => u !== undefined),
      total: described.UserPool?.EstimatedNumberOfUsers ?? 0,
      approximate: true,
      ...(page.PaginationToken ? { nextToken: page.PaginationToken } : {}),
    };
  }

  /**
   * One member by canonical id (Cognito sub). `ListUsers` with the exact-match `sub =` filter -
   * sub is a filterable standard attribute; there is no direct get-by-sub (usernames are phones).
   */
  async getBySub(sub: string): Promise<AdminUserItem | undefined> {
    const cleaned = sub.replace(/["\\]/g, "");
    const page = await this.client.send(
      new ListUsersCommand({
        UserPoolId: this.userPoolId,
        Limit: 1,
        Filter: `sub = "${cleaned}"`,
      }),
    );
    const user = page.Users?.[0];
    return user ? toAdminUserItem(user) : undefined;
  }

  /** `AdminDisableUser` - reversible suspension, with `AdminGetUser` FIRST so the caller learns
   * whether the user was actually enabled before this call (and the member's canonical sub, for
   * the audit-writer event). Re-disabling stays idempotent success in Cognito, but reports
   * `wasEnabled: false` - the customer counter must count each suspension ONCE, so a repeat must
   * not mark another user disabled. found=false = unknown phone (404). */
  async disable(phone: string): Promise<{ found: boolean; wasEnabled: boolean; sub?: string }> {
    const user = await this.getUser(phone);
    if (!user) return { found: false, wasEnabled: false };
    const found = await this.lifecycle(
      new AdminDisableUserCommand({ UserPoolId: this.userPoolId, Username: phone }),
    );
    return { found, wasEnabled: found && user.Enabled !== false, ...subOf(user) };
  }

  /** `AdminEnableUser` - lift a suspension. Symmetric to `disable`: `wasDisabled` reports whether
   * the lift actually changed state, so a repeated lift never double-counts on the counter. */
  async enable(phone: string): Promise<{ found: boolean; wasDisabled: boolean; sub?: string }> {
    const user = await this.getUser(phone);
    if (!user) return { found: false, wasDisabled: false };
    const found = await this.lifecycle(
      new AdminEnableUserCommand({ UserPoolId: this.userPoolId, Username: phone }),
    );
    return { found, wasDisabled: found && user.Enabled === false, ...subOf(user) };
  }

  /** `AdminUserGlobalSignOut` - revoke every refresh token (issued access tokens live out
   * their hour - the stateless-authorizer caveat lives in the contract comment). Resolves the
   * user FIRST (like disable/enable) so the caller gets the sub for the audit-writer event. */
  async globalSignOut(phone: string): Promise<{ found: boolean; sub?: string }> {
    const user = await this.getUser(phone);
    if (!user) return { found: false };
    const found = await this.lifecycle(
      new AdminUserGlobalSignOutCommand({ UserPoolId: this.userPoolId, Username: phone }),
    );
    return { found, ...subOf(user) };
  }

  private async lifecycle(
    command: AdminDisableUserCommand | AdminEnableUserCommand | AdminUserGlobalSignOutCommand,
  ): Promise<boolean> {
    try {
      await this.client.send(command);
      return true;
    } catch (err) {
      if (err instanceof UserNotFoundException) return false;
      throw err;
    }
  }

  /**
   * Remove the account, resolving the sub FIRST (via `AdminGetUser`) so the caller can erase the
   * member's DynamoDB recommendations under it (ADR-0006 decision 8). An already-deleted account
   * resolves as `existed: false` so the SPA's retry is idempotent. `wasDisabled` is the account's
   * suspension state at deletion time - the customer counter decrements its `disabled` count too
   * when a suspended account is erased.
   */
  async remove(phone: string): Promise<{ existed: boolean; sub?: string; wasDisabled: boolean }> {
    const user = await this.getUser(phone);
    if (!user) return { existed: false, wasDisabled: false };
    const sub = user.UserAttributes?.find((a) => a.Name === "sub")?.Value;
    const wasDisabled = user.Enabled === false;
    try {
      await this.client.send(
        new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: phone }),
      );
    } catch (err) {
      // Vanished between the two calls: still report existed (we saw it) and hand back the sub
      // so the recommendation cleanup runs regardless.
      if (!(err instanceof UserNotFoundException)) throw err;
    }
    return { existed: true, wasDisabled, ...(sub ? { sub } : {}) };
  }

  /** `AdminGetUser`, resolving an unknown phone to undefined instead of throwing. */
  private async getUser(phone: string): Promise<AdminGetUserCommandOutput | undefined> {
    try {
      return await this.client.send(
        new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: phone }),
      );
    } catch (err) {
      if (err instanceof UserNotFoundException) return undefined;
      throw err;
    }
  }
}
