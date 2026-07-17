import { Logger } from "@aws-lambda-powertools/logger";
import type { ProductItem, ProductRepo } from "@wanthat/dynamo";
import { describe, expect, it } from "vitest";
import type { GenerateLinkDeps } from "./generate-link";
import { handleGenerateLink } from "./handler";

/**
 * Wire-shape parity with the pre-split retailer-proxy (refactor PR-6): the linkgen handler
 * still accepts the exact `GenerateLinkRequest` invoke payload (`op`/`retailer`/`url`), so the
 * app-links caller's move was an env-var flip — no payload migration, no client change.
 */

const NOW = "2026-07-08T10:00:00.000Z";

const STORED: ProductItem = {
  storeId: "aliexpress",
  storeProductId: "1005006123456789",
  title: "Jebao Smart Aquarium Fish Feeder",
  imageUrl: "https://ae01.alicdn.com/kf/feeder.jpg",
  price: { amountMinor: "2612", currency: "USD" },
  commissionBps: 700,
  affiliateUrl: "https://s.click.aliexpress.com/e/_stored",
  createdAt: NOW,
  updatedAt: NOW,
};

function deps(existing?: ProductItem): GenerateLinkDeps {
  return {
    products: { get: async () => existing } as unknown as ProductRepo,
    client: async () => null,
    logger: new Logger({ serviceName: "test", logLevel: "SILENT" }),
  };
}

describe("handleGenerateLink", () => {
  it("serves the pre-split wire shape unchanged (op + retailer + url)", async () => {
    const res = await handleGenerateLink(
      {
        op: "generateLink",
        retailer: "aliexpress",
        url: "https://he.aliexpress.com/item/1005006123456789.html",
      },
      deps(STORED),
    );
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.affiliateUrl).toBe(STORED.affiliateUrl);
  });

  it("answers the typed unsupported_url error on a foreign op or malformed event, never throws", async () => {
    for (const event of [
      { op: "listOrders", retailer: "aliexpress" }, // the poll moved to retailer-settlement
      { op: "generateLink", retailer: "aliexpress" }, // url missing
      { op: "generateLink", retailer: "amazon", url: "https://x.example/item/1.html" },
      "not-an-object",
      null,
    ]) {
      expect(await handleGenerateLink(event, deps())).toEqual({
        status: "error",
        code: "unsupported_url",
      });
    }
  });
});
