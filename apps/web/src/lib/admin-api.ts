import type {
  ConfigKey,
  ConfigValue,
  GetConfigResponse,
  ListConfigResponse,
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
    if (fresh) res = await doFetch(fresh.accessToken);
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

export type { UsersStats };
