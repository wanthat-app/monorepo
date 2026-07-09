import { describe, expect, it } from "vitest";
import { deriveBalances, type LedgerRow } from "./wallet";

const row = (partial: Partial<LedgerRow>): LedgerRow => ({
  kind: "referrer_cashback",
  amountMinor: 100n,
  currency: "USD",
  orderId: "order-1",
  status: "pending",
  ...partial,
});

describe("deriveBalances", () => {
  it("returns [] for an empty ledger", () => {
    expect(deriveBalances([])).toEqual([]);
  });

  it("sums pending-only rewards into the role buckets, nothing available", () => {
    const balances = deriveBalances([
      row({ kind: "referrer_cashback", amountMinor: 400n, orderId: "order-1" }),
      row({ kind: "consumer_reward", amountMinor: 200n, orderId: "order-1" }),
      row({ kind: "referrer_cashback", amountMinor: 50n, orderId: "order-2" }),
    ]);
    expect(balances).toEqual([
      {
        asRecommender: {
          confirmed: { amountMinor: 0n, currency: "USD" },
          pending: { amountMinor: 450n, currency: "USD" },
        },
        asBuyer: {
          confirmed: { amountMinor: 0n, currency: "USD" },
          pending: { amountMinor: 200n, currency: "USD" },
        },
        available: { amountMinor: 0n, currency: "USD" },
      },
    ]);
  });

  it("counts a pending+confirmed lifecycle for one (orderId, kind) once, as confirmed", () => {
    const balances = deriveBalances([
      row({ amountMinor: 400n, status: "pending" }),
      row({ amountMinor: 400n, status: "confirmed" }),
    ]);
    expect(balances).toEqual([
      {
        asRecommender: {
          confirmed: { amountMinor: 400n, currency: "USD" },
          pending: { amountMinor: 0n, currency: "USD" },
        },
        asBuyer: {
          confirmed: { amountMinor: 0n, currency: "USD" },
          pending: { amountMinor: 0n, currency: "USD" },
        },
        available: { amountMinor: 400n, currency: "USD" },
      },
    ]);
  });

  it("lets a clawback zero a previously confirmed reward", () => {
    const balances = deriveBalances([
      row({ amountMinor: 400n, status: "pending" }),
      row({ amountMinor: 400n, status: "confirmed" }),
      row({ amountMinor: 400n, status: "clawback" }),
      // A second, untouched order keeps the derivation honest (only order-1 is clawed back).
      row({ amountMinor: 100n, orderId: "order-2", status: "confirmed" }),
    ]);
    expect(balances).toEqual([
      {
        asRecommender: {
          confirmed: { amountMinor: 100n, currency: "USD" },
          pending: { amountMinor: 0n, currency: "USD" },
        },
        asBuyer: {
          confirmed: { amountMinor: 0n, currency: "USD" },
          pending: { amountMinor: 0n, currency: "USD" },
        },
        available: { amountMinor: 100n, currency: "USD" },
      },
    ]);
  });

  it("subtracts withdrawals from available (role buckets untouched)", () => {
    const balances = deriveBalances([
      row({ amountMinor: 500n, status: "confirmed" }),
      row({ kind: "withdrawal", amountMinor: 200n, orderId: null, status: "confirmed" }),
    ]);
    expect(balances[0]?.available).toEqual({ amountMinor: 300n, currency: "USD" });
    expect(balances[0]?.asRecommender.confirmed).toEqual({ amountMinor: 500n, currency: "USD" });
  });

  it("adds adjustments to available (role buckets untouched)", () => {
    const balances = deriveBalances([
      row({ kind: "consumer_reward", amountMinor: 500n, status: "confirmed" }),
      row({ kind: "adjustment", amountMinor: 70n, orderId: null, status: "confirmed" }),
    ]);
    expect(balances[0]?.available).toEqual({ amountMinor: 570n, currency: "USD" });
    expect(balances[0]?.asBuyer.confirmed).toEqual({ amountMinor: 500n, currency: "USD" });
  });

  it("keeps currencies apart: one WalletBalance per currency held, ordered by currency", () => {
    const balances = deriveBalances([
      row({ amountMinor: 400n, currency: "USD", status: "confirmed" }),
      row({ amountMinor: 900n, currency: "ILS", orderId: "order-2", status: "pending" }),
    ]);
    expect(balances).toHaveLength(2);
    expect(balances[0]?.available).toEqual({ amountMinor: 0n, currency: "ILS" });
    expect(balances[0]?.asRecommender.pending).toEqual({ amountMinor: 900n, currency: "ILS" });
    expect(balances[1]?.available).toEqual({ amountMinor: 400n, currency: "USD" });
  });
});
