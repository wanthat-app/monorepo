import type {
  CatalogStats,
  CognitoDeleteUserResponse,
  ConfigKey,
  ConfigValue,
  DisableUserResponse,
  EnableUserResponse,
  GetConfigResponse,
  GlobalSignOutUserResponse,
  ListActivityResponse,
  ListConfigResponse,
  ListUsersResponse,
  PutConfigResponse,
  PutRetailerCredentialsBody,
  RetailerCredentialsStatus,
  UsersStats,
} from "@wanthat/contracts";
import { beginAdminLogin, clearAdminTokens, refreshAdminTokens } from "./admin-login";
import { ApiError } from "./api";
import { getConfig } from "./config";

/**
 * Client for the admin-api surface (a separate HTTP API from app-api). Bearer per call; the server
 * re-enforces the admin group, so this is for the operator console only. Base URL from runtime config.
 */

export interface StatsOverview {
  /** EXACT confirmed-customer count — the `#customerCounter` sentinel item (runtime config
   * table), kept by the Post-Confirmation trigger + the admin moderation routes. Narrower than
   * the users page's approximate whole-pool total (which includes UNCONFIRMED) on purpose. */
  usersCount: number;
  pendingApprovals: number | null;
  totalCashbackMinor: number | null;
  conversions30d: number | null;
}

async function adminRequest<T>(
  path: string,
  token: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const doFetch = (bearer: string) =>
    fetch(`${getConfig().adminApiUrl}${path}`, {
      method: opts.method ?? "GET",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await doFetch(token);
  // 401 = the token expired (or was revoked) mid-session: refresh once and retry. If that still
  // fails, the session is gone — clear it and restart the hosted-UI login instead of surfacing a
  // generic load error on every panel.
  if (res.status === 401) {
    const fresh = await refreshAdminTokens();
    if (fresh) res = await doFetch(fresh.idToken);
    if (res.status === 401) {
      clearAdminTokens();
      void beginAdminLogin();
    }
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, (data.error as string) ?? "request_failed");
  return data as T;
}

export const adminApi = {
  listConfig: (token: string) => adminRequest<ListConfigResponse>("/admin/config", token),
  getConfig: (token: string, key: ConfigKey) =>
    adminRequest<GetConfigResponse>(`/admin/config/${key}`, token),
  putConfig: (token: string, key: ConfigKey, value: ConfigValue) =>
    adminRequest<PutConfigResponse>(`/admin/config/${key}`, token, {
      method: "PUT",
      body: { value },
    }),
  statsOverview: (token: string) => adminRequest<StatsOverview>("/admin/stats/overview", token),
  usersStats: (token: string) => adminRequest<UsersStats>("/admin/stats/users", token),
  catalogStats: (token: string) => adminRequest<CatalogStats>("/admin/stats/catalog", token),
  // Activity page: paged audit-log feed (+ dev OTP codes merged server-side on page 1 in dev).
  listActivity: (token: string, opts: { page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.page) params.set("page", String(opts.page));
    if (opts.pageSize) params.set("pageSize", String(opts.pageSize));
    const qs = params.toString();
    return adminRequest<ListActivityResponse>(`/admin/activity${qs ? `?${qs}` : ""}`, token);
  },
  // Users page (Cognito-backed, ADR-0006): forward-only token pagination (no random-access page),
  // `search` is an E.164 phone PREFIX (Cognito `phone_number ^=`), pageSize is capped at Cognito's
  // Limit max of 60.
  listUsers: (
    token: string,
    opts: { search?: string; pageSize?: number; nextToken?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.search) params.set("search", opts.search);
    if (opts.pageSize) params.set("pageSize", String(opts.pageSize));
    if (opts.nextToken) params.set("nextToken", opts.nextToken);
    const qs = params.toString();
    return adminRequest<ListUsersResponse>(`/admin/users${qs ? `?${qs}` : ""}`, token);
  },
  // Account erasure, single step since T7 (the Aurora DELETE /admin/users/:id is 410 Gone):
  // removes the Cognito account and the member's recommendations; idempotent on a gone account.
  cognitoDeleteUser: (token: string, phone: string) =>
    adminRequest<CognitoDeleteUserResponse>("/admin/users/cognito-delete", token, {
      method: "POST",
      body: { phone },
    }),
  // Moderation (ADR-0006 decision 8), phone-keyed — phone is the pool username. Suspend = disable
  // (reversible), lift = enable, kick = global sign-out. Caveat surfaced in the SPA confirm copy:
  // the JWT authorizer is stateless, so already-issued access tokens survive up to 1 h.
  disableUser: (token: string, phone: string) =>
    adminRequest<DisableUserResponse>("/admin/users/disable", token, {
      method: "POST",
      body: { phone },
    }),
  enableUser: (token: string, phone: string) =>
    adminRequest<EnableUserResponse>("/admin/users/enable", token, {
      method: "POST",
      body: { phone },
    }),
  globalSignOutUser: (token: string, phone: string) =>
    adminRequest<GlobalSignOutUserResponse>("/admin/users/global-signout", token, {
      method: "POST",
      body: { phone },
    }),
  // Write-only retailer credentials (AliExpress): PUT replaces both values; both routes answer
  // with non-secret status only — the credential can never be read back.
  retailerCredentialsStatus: (token: string) =>
    adminRequest<RetailerCredentialsStatus>("/admin/retailer/aliexpress/credentials", token),
  putRetailerCredentials: (token: string, body: PutRetailerCredentialsBody) =>
    adminRequest<RetailerCredentialsStatus>("/admin/retailer/aliexpress/credentials", token, {
      method: "PUT",
      body,
    }),
};

/**
 * Normalize an operator-typed phone-prefix search to the E.164 prefix Cognito filters on
 * (`phone_number ^= "..."`). Unlike `normalizePhone` (contracts), the input is a PREFIX, not a
 * complete number, so libphonenumber validation would reject it — this is plain string surgery:
 * separators are stripped, Israel's trunk `0` (e.g. `05x…`) becomes `+9725x…`, `00`/bare-`972`
 * international forms gain the `+`, and any other bare digits are assumed local-IL (launch is
 * Israel-only). Empty input stays empty (no filter).
 */
export function normalizePhonePrefix(input: string): string {
  const raw = input.replace(/[\s\-().]/g, "");
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  if (raw.startsWith("00")) return `+${raw.slice(2)}`;
  if (raw.startsWith("972")) return `+${raw}`;
  if (raw.startsWith("0")) return `+972${raw.slice(1)}`;
  return `+972${raw}`;
}

export type { CatalogStats, UsersStats };
