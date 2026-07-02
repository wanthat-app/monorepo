import type {
  AttributionClaimResponse,
  AuthConfigResponse,
  AuthRefreshResponse,
  AuthResendResponse,
  AuthSession,
  AuthSessionResponse,
  AuthStartResponse,
  AuthVerifyResponse,
  CustomerProfile,
  MessageLanguage,
  OtpChannel,
  PasskeyRegisterVerifyResponse,
} from "@wanthat/contracts";
import { getConfig } from "./config";

/**
 * Typed client for the app-api `/auth` + `/me` surface. Cookieless (ADR-0007): the access token is
 * passed as a Bearer header per call; nothing is stored in a cookie. The base URL comes from the
 * runtime config (`/config.json` on the deployed site; `.env.local` in local dev).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${getConfig().apiUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, (data.error as string) ?? "request_failed");
  return data as T;
}

export const authApi = {
  // Channel availability projection (ADR-0023) — fetched pre-login to render the channel choice.
  config: () => request<AuthConfigResponse>("/auth/config"),
  start: (phone: string, channel: OtpChannel, locale?: MessageLanguage) =>
    request<AuthStartResponse>("/auth/start", {
      method: "POST",
      body: { phone, channel, ...(locale ? { locale } : {}) },
    }),
  resend: (challengeId: string, channel: OtpChannel) =>
    request<AuthResendResponse>("/auth/resend", { method: "POST", body: { challengeId, channel } }),
  verify: (challengeId: string, code: string) =>
    request<AuthVerifyResponse>("/auth/verify", { method: "POST", body: { challengeId, code } }),
  // Resolve a verify ticket to a session: `authenticated` (login) or `registration_required` (new).
  session: (registrationTicket: string) =>
    request<AuthSessionResponse>("/auth/session", { method: "POST", body: { registrationTicket } }),
  register: (body: {
    registrationTicket: string;
    firstName: string;
    lastName: string;
    email?: string;
    locale?: string;
  }) => request<AuthSession>("/auth/register", { method: "POST", body }),
  refresh: (refreshToken: string) =>
    request<AuthRefreshResponse>("/auth/refresh", { method: "POST", body: { refreshToken } }),
  signout: (refreshToken: string) =>
    request<{ ok: true }>("/auth/signout", { method: "POST", body: { refreshToken } }),
  passkeyRegisterOptions: (token: string) =>
    request<{ options: unknown }>("/auth/passkey/register/options", {
      method: "POST",
      body: {},
      token,
    }),
  passkeyRegisterVerify: (credential: unknown, token: string) =>
    request<PasskeyRegisterVerifyResponse>("/auth/passkey/register/verify", {
      method: "POST",
      body: { credential },
      token,
    }),
};

export const meApi = {
  get: (token: string) => request<{ profile: CustomerProfile }>("/me", { token }),
  update: (
    token: string,
    patch: Partial<Pick<CustomerProfile, "firstName" | "lastName" | "locale" | "email">>,
  ) => request<{ profile: CustomerProfile }>("/me", { method: "PATCH", body: patch, token }),
  claimAttribution: (token: string, guestIds: string[]) =>
    request<AttributionClaimResponse>("/me/attribution/claim", {
      method: "POST",
      body: { guestIds },
      token,
    }),
};
