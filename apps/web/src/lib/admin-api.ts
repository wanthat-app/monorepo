import type {
  ConfigKey,
  ConfigValue,
  GetConfigResponse,
  ListConfigResponse,
  PutConfigResponse,
} from "@wanthat/contracts";
import { ApiError } from "./api";

/**
 * Client for the admin-api surface (a separate HTTP API from app-api). Bearer per call; the server
 * re-enforces the admin group, so this is for the operator console only.
 */
const ADMIN_URL: string = import.meta.env.VITE_ADMIN_API_URL ?? "";

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
  const res = await fetch(`${ADMIN_URL}${path}`, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
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
};
