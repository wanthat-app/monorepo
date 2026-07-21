import { describe, expect, it } from "vitest";
import { selectWalletRender, type WalletWire } from "./walletView";

const wire: WalletWire = { balances: [], estimated: null };
const cached: WalletWire = { balances: [], estimated: null };

describe("selectWalletRender — the spec's five-row state table", () => {
  it("fresh data wins regardless of cache", () => {
    expect(selectWalletRender({ data: wire, isError: false }, cached)).toEqual({
      kind: "fresh",
      data: wire,
    });
  });
  it("pending + cache → stale", () => {
    expect(selectWalletRender({ data: undefined, isError: false }, cached)).toEqual({
      kind: "stale",
      data: cached,
    });
  });
  it("pending + no cache → skeleton", () => {
    expect(selectWalletRender({ data: undefined, isError: false }, null)).toEqual({
      kind: "skeleton",
    });
  });
  it("error + cache → stale (silent retry keeps running)", () => {
    expect(selectWalletRender({ data: undefined, isError: true }, cached)).toEqual({
      kind: "stale",
      data: cached,
    });
  });
  it("error + no cache → error card", () => {
    expect(selectWalletRender({ data: undefined, isError: true }, null)).toEqual({
      kind: "error",
    });
  });
});
