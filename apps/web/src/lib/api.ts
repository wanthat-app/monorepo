import type { ConfigKey, ConfigValue } from "@wanthat/contracts";
import { getConfig } from "./config";

/**
 * Typed client for the app-api surface — wallet + links only since ADR-0006 (authentication
 * and profile live entirely in the `user/` module, which talks to Cognito directly).
 * Cookieless (ADR-0007): the access token is passed as a Bearer header per call; nothing is
 * stored in a cookie. The base URL comes from the runtime config (`/config.json` on the
 * deployed site; `.env.local` in local dev).
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

/**
 * PUBLIC runtime-config projection (`GET /config?keys=…`, no auth): the server answers only
 * keys allow-listed in contracts `CONFIG_PUBLIC` — anything else is a 400. Read pre-sign-in
 * (e.g. which OTP channels the register screen offers).
 */
export const configApi = {
  getPublic: (keys: readonly ConfigKey[]) =>
    request<{ values: Record<string, ConfigValue> }>(
      `/config?keys=${encodeURIComponent(keys.join(","))}`,
    ),
};

/**
 * Wire types for the wallet surface: `Money.amountMinor` travels as a decimal string (JSON has
 * no bigint). Formatting stays in lib/money.ts; nothing here converts to floats.
 */
export interface MoneyWire {
  amountMinor: string;
  currency: string;
}
export interface WalletEarningsWire {
  confirmed: MoneyWire;
  pending: MoneyWire;
}
export interface WalletBalanceWire {
  asRecommender: WalletEarningsWire;
  asBuyer: WalletEarningsWire;
  available: MoneyWire;
}
export interface WalletEstimateWire {
  available: MoneyWire;
  pending: MoneyWire;
}
export interface WalletEntryWire {
  id: string;
  kind: "referrer_cashback" | "consumer_reward" | "adjustment" | "withdrawal";
  amount: MoneyWire;
  status: "pending" | "confirmed" | "clawback";
  recommendationId: string | null;
  createdAt: string;
}

/**
 * One item of the member activity feed. Since the merge moved CLIENT-SIDE (refactor PR 2b) this
 * is the feed's DISPLAY type only — no endpoint answers it. The SPA maps the two paginated
 * sources onto it: `GET /recommendations` (app-links) and `GET /wallet/entries` (app-core).
 */
export type ActivityItemWire =
  | {
      type: "recommendation_created";
      recommendationId: string;
      title: string;
      imageUrl: string | null;
      at: string;
    }
  | {
      type: "wallet_entry";
      id: string;
      kind: "referrer_cashback" | "consumer_reward" | "adjustment" | "withdrawal";
      amount: { amountMinor: string; currency: string };
      status: "pending" | "confirmed" | "clawback";
      recommendationId: string | null;
      at: string;
    };

const pageQuery = (opts: { limit?: number; cursor?: string }): string => {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
};

export const walletApi = {
  get: (token: string) =>
    request<{ balances: WalletBalanceWire[]; estimated: WalletEstimateWire | null }>("/wallet", {
      token,
    }),
  // Newest-first ledger history; the opaque cursor is the server's (createdAt, id) keyset key.
  entries: (token: string, opts: { limit?: number; cursor?: string } = {}) =>
    request<{ items: WalletEntryWire[]; nextCursor: string | null }>(
      `/wallet/entries${pageQuery(opts)}`,
      { token },
    ),
};

/** Wire types for the create-link surface (Money travels as decimal strings — see MoneyWire). */
export interface ProductWire {
  storeId: "aliexpress";
  storeProductId: string;
  title: string;
  imageUrl: string | null;
  price: MoneyWire | null;
  commissionBps: number;
  createdAt: string;
  updatedAt: string;
}
export interface CashbackShareWire {
  rateBps: number;
  estimated: MoneyWire | null;
}
export interface CashbackEstimateWire {
  referrer: CashbackShareWire;
  consumer: CashbackShareWire;
}
export interface ReviewWire {
  rating?: number;
  text: string;
}
/** Cached settlement→display rate + FX margin for client-side ₪ conversion (see contracts DisplayFx). */
export interface DisplayFxWire {
  rate: { base: string; quote: string; rate: string; asOf: string };
  commissionBps: number;
}
export interface RecommendationWire {
  recommendationId: string;
  shareUrl: string;
  product: ProductWire;
  cashback: { referrerBps: number; consumerBps: number };
  estimate: CashbackEstimateWire;
  review: ReviewWire | null;
  createdAt: string;
  updatedAt: string;
}
/** One row of GET /recommendations (contracts RecommendationSummary) — the list projection. */
export interface RecommendationSummaryWire {
  recommendationId: string;
  shareUrl: string;
  title: string;
  imageUrl: string | null;
  stats: { clicks: number; conversions: number };
  createdAt: string;
}

export const linksApi = {
  // My recommendations, newest first (byOwner GSI); the cursor is the server's opaque keyset key.
  list: (token: string, opts: { limit?: number; cursor?: string } = {}) =>
    request<{ items: RecommendationSummaryWire[]; nextCursor: string | null }>(
      `/recommendations${pageQuery(opts)}`,
      { token },
    ),
  // Paste URL → the shared product + a current-policy cashback estimate. The server mints the
  // product-level affiliate link on first resolve; the URL itself is never fetched by the SPA.
  resolveProduct: (token: string, url: string) =>
    request<{
      product: ProductWire;
      estimate: CashbackEstimateWire;
      displayFx: DisplayFxWire | null;
    }>("/products/resolve", {
      method: "POST",
      body: { url },
      token,
    }),
  // Mint my shareable link for a resolved product (idempotent on owner+product server-side).
  createRecommendation: (
    token: string,
    body: { storeId: "aliexpress"; storeProductId: string; review?: ReviewWire },
  ) =>
    request<{ recommendation: RecommendationWire }>("/recommendations", {
      method: "POST",
      body,
      token,
    }),
  // Set or clear my review on an existing link (the summary screen edits it in place).
  updateReview: (token: string, recommendationId: string, review: ReviewWire | null) =>
    request<{ recommendation: RecommendationWire }>(`/recommendations/${recommendationId}`, {
      method: "PATCH",
      body: { review },
      token,
    }),
};
