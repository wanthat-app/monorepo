/**
 * Display formatting for wire `Money` (integer minor units as a decimal string — see
 * contracts/common/money.ts). String/bigint math only: minor-unit amounts must never pass
 * through floats. All output is symbol-leading (`₪142.50`); the caller (DS components) pins
 * LTR + tabular numerals.
 */

const SYMBOLS: Record<string, string> = { ILS: "₪", USD: "$", EUR: "€", GBP: "£" };

function parts(amountMinor: string, currency: string): { sign: string; int: string; frac: string; symbol: string } {
  const neg = amountMinor.startsWith("-");
  const digits = (neg ? amountMinor.slice(1) : amountMinor).padStart(3, "0");
  const int = digits
    .slice(0, -2)
    .replace(/^0+(?=\d)/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return {
    sign: neg ? "-" : "",
    int,
    frac: digits.slice(-2),
    symbol: SYMBOLS[currency] ?? `${currency} `,
  };
}

/** "14250" + ILS → "₪142.50"; unknown currency falls back to "JPY 1.00". */
export function formatMoneyMinor(amountMinor: string, currency: string): string {
  const p = parts(amountMinor, currency);
  return `${p.sign}${p.symbol}${p.int}.${p.frac}`;
}

/** "14250" + ILS → ["₪142", ".50"] — BalanceCard renders amount and fraction separately. */
export function splitMoneyMinor(amountMinor: string, currency: string): [string, string] {
  const p = parts(amountMinor, currency);
  return [`${p.sign}${p.symbol}${p.int}`, `.${p.frac}`];
}
