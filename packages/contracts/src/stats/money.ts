import { z } from "zod";
import { Currency, Money } from "../common";
import { DailyCount } from "./daily";

/** Confirmed + pending platform cashback held in one currency (all-time, lifecycle-collapsed). */
export const MoneyCurrencyTotals = z.object({
  currency: Currency,
  confirmed: Money,
  pending: Money,
});
export type MoneyCurrencyTotals = z.infer<typeof MoneyCurrencyTotals>;

/**
 * GET /admin/stats/money — dashboard money KPIs, derived per request from the `wallet_entry`
 * ledger (spec 2026-07-13, approach A: nothing stored). Semantics mirror the member wallet:
 * lifecycle collapse per (currency, orderId, kind), furthest status wins, clawback = 0.
 *
 * - `totals`: per-currency all-time confirmed/pending reward sums (adjustments/withdrawals are
 *   member movements, not platform cashback — excluded).
 * - `ilsEstimate`: display-only ₪ conversion of the USD totals (cached rate minus the
 *   fx.conversionCommissionBps — identical to the member wallet's `≈₪`). Hard zeros when no
 *   USD is held; null ONLY when USD is held but no rate is cached. `confirmedInWindow` is the
 *   confirmed sum bucketed inside the 30-day window — the numerator of the PRD §3.2 go/no-go
 *   metric (₪ per active member), which the admin SPA computes CLIENT-side against the
 *   `active30d` it already fetches from GET /admin/stats/users (refactor PR-5: the money route
 *   is a pure ledger read and carries no active-member figure).
 * - `conversions30d` / `dailyConversions`: distinct attributed orders, bucketed to the
 *   Jerusalem date of the order's earliest reward row; dense 30-entry series.
 */
export const MoneyStats = z.object({
  totals: z.array(MoneyCurrencyTotals),
  ilsEstimate: z.object({ confirmed: Money, pending: Money, confirmedInWindow: Money }).nullable(),
  conversions30d: z.number().int().nonnegative(),
  dailyConversions: z.array(DailyCount).length(30),
});
export type MoneyStats = z.infer<typeof MoneyStats>;
