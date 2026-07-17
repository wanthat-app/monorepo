/**
 * The error shape + wallet wire types shared with the member app's api.ts (`Money.amountMinor`
 * travels as a decimal string — JSON has no bigint). Duplicated here deliberately when the admin
 * console moved to its own app: the member client itself (walletApi/linksApi/configApi) is not
 * needed on the admin surface, only these few type shapes for admin-api's wallet views.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

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
export interface WalletEntryWire {
  id: string;
  kind: "referrer_cashback" | "consumer_reward" | "adjustment" | "withdrawal";
  amount: MoneyWire;
  status: "pending" | "confirmed" | "clawback";
  recommendationId: string | null;
  createdAt: string;
}
