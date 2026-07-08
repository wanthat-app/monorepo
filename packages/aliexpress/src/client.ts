import { z } from "zod";
import { signParams } from "./sign";

/**
 * Signed AliExpress Affiliate client on the System Interface gateway
 * (`api-sg.aliexpress.com/sync`, HMAC-SHA256 — SDD Appendix A; never the legacy MD5 gateway).
 * Transport-only: it signs, calls, parses and throws typed errors; mapping to Wanthat error
 * codes stays with the caller (retailer-proxy). `fetchFn` is injectable for tests.
 */

export const ALIEXPRESS_GATEWAY = "https://api-sg.aliexpress.com/sync";

/** Params for aliexpress.affiliate.order.listbyindex (time-window + cursor, GMT+8). */
export interface OrderListByIndexParams {
  startTime: string; // "yyyy-MM-dd HH:mm:ss", GMT+8
  endTime: string; // "yyyy-MM-dd HH:mm:ss", GMT+8
  status: string;
  startQueryIndexId?: string;
  pageSize?: number;
}

export interface AliExpressClientOptions {
  appKey: string;
  appSecret: string;
  /** The single Wanthat tracking id registered with AliExpress (SDD §8.1 — never per-user). */
  trackingId: string;
  gateway?: string;
  fetchFn?: typeof fetch;
  /** Injectable clock for deterministic signing tests. */
  now?: () => number;
}

/** A platform-level error answered by the gateway (`error_response`) or a malformed payload. */
export class AliExpressApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`aliexpress ${code}: ${message}`);
  }
}

const ErrorResponse = z.object({
  error_response: z.object({
    code: z.coerce.string(),
    msg: z.string().optional(),
  }),
});

const LinkGenerateResponse = z.object({
  aliexpress_affiliate_link_generate_response: z.object({
    resp_result: z.object({
      result: z
        .object({
          promotion_links: z
            .object({
              promotion_link: z.array(
                z.object({
                  source_value: z.string().optional(),
                  promotion_link: z.string(),
                }),
              ),
            })
            .optional(),
        })
        .optional(),
    }),
  }),
});

const ProductDetailResponse = z.object({
  aliexpress_affiliate_productdetail_get_response: z.object({
    resp_result: z.object({
      result: z
        .object({
          products: z
            .object({
              product: z.array(
                z
                  .object({
                    product_title: z.string().optional(),
                    product_main_image_url: z.string().optional(),
                    target_sale_price: z.string().optional(),
                    target_sale_price_currency: z.string().optional(),
                    commission_rate: z.union([z.string(), z.number()]).optional(),
                    hot_product_commission_rate: z.union([z.string(), z.number()]).optional(),
                  })
                  .passthrough(),
              ),
            })
            .optional(),
        })
        .optional(),
    }),
  }),
});

export interface AliExpressProductDetail {
  title: string | null;
  imageUrl: string | null;
  /** Integer minor units as a decimal string (exact — never a float), or null when unpriced. */
  priceMinor: string | null;
  priceCurrency: string | null;
  /** Network commission rate in bps, or null when the payload carries no usable rate. */
  commissionBps: number | null;
}

/** `"7.5%"` / `"7.5"` / `7.5` (percent) → 750 bps, clamped to the Bps range; null when unusable. */
export function commissionRateToBps(rate: string | number | undefined): number | null {
  if (rate === undefined) return null;
  const numeric = typeof rate === "number" ? rate : Number.parseFloat(rate.replace("%", ""));
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.min(10_000, Math.round(numeric * 100));
}

/** Decimal price string (e.g. `"26.12"`) → integer minor-unit string (`"2612"`), exact; null when malformed. */
export function decimalToMinor(price: string | undefined): string | null {
  if (price === undefined) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(price.trim());
  if (!match?.[1]) return null;
  const frac = match[2] ?? "";
  return (BigInt(match[1]) * 100n + BigInt(frac.padEnd(2, "0"))).toString();
}

export class AliExpressClient {
  private readonly gateway: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: AliExpressClientOptions) {
    this.gateway = options.gateway ?? ALIEXPRESS_GATEWAY;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * aliexpress.affiliate.link.generate — mint the **product-level** promotion link for a product
   * URL (ADR-0008: one per product; attribution rides `custom_parameters` at click time, so no
   * SubID is baked here). Returns the promotion link.
   */
  async generatePromotionLink(sourceUrl: string, timeoutMs = 8000): Promise<string> {
    const data = await this.call(
      "aliexpress.affiliate.link.generate",
      {
        promotion_link_type: "0",
        source_values: sourceUrl,
        tracking_id: this.options.trackingId,
      },
      timeoutMs,
    );
    const parsed = LinkGenerateResponse.safeParse(data);
    const links =
      parsed.success &&
      parsed.data.aliexpress_affiliate_link_generate_response.resp_result.result?.promotion_links
        ?.promotion_link;
    const link = links ? links[0]?.promotion_link : undefined;
    if (!link) throw new AliExpressApiError("empty_result", "link.generate returned no link");
    return link;
  }

  /**
   * aliexpress.affiliate.productdetail.get — title/image/price/commission for a product id,
   * in the settlement currency (USD). Best-effort at the call site: the caller caps the timeout
   * and treats a throw as "no metadata".
   */
  async getProductDetail(productId: string, timeoutMs = 2500): Promise<AliExpressProductDetail> {
    const data = await this.call(
      "aliexpress.affiliate.productdetail.get",
      {
        product_ids: productId,
        target_currency: "USD",
        target_language: "EN",
        tracking_id: this.options.trackingId,
      },
      timeoutMs,
    );
    const parsed = ProductDetailResponse.safeParse(data);
    const products =
      parsed.success &&
      parsed.data.aliexpress_affiliate_productdetail_get_response.resp_result.result?.products
        ?.product;
    const product = products ? products[0] : undefined;
    if (!product)
      throw new AliExpressApiError("empty_result", "productdetail.get returned no product");
    return {
      title: product.product_title ?? null,
      imageUrl: product.product_main_image_url ?? null,
      priceMinor: decimalToMinor(product.target_sale_price),
      priceCurrency: product.target_sale_price
        ? (product.target_sale_price_currency ?? "USD")
        : null,
      commissionBps: commissionRateToBps(
        product.commission_rate ?? product.hot_product_commission_rate,
      ),
    };
  }

  /** Sign + POST one gateway method; throws AliExpressApiError on platform errors. */
  private async call(
    method: string,
    businessParams: Record<string, string>,
    timeoutMs: number,
  ): Promise<unknown> {
    const params: Record<string, string> = {
      ...businessParams,
      app_key: this.options.appKey,
      method,
      v: "2.0",
      format: "json",
      sign_method: "sha256",
      timestamp: String(this.now()),
    };
    params.sign = signParams(params, this.options.appSecret);

    const res = await this.fetchFn(this.gateway, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new AliExpressApiError(`http_${res.status}`, "gateway request failed");
    const data: unknown = await res.json();
    const err = ErrorResponse.safeParse(data);
    if (err.success) {
      const { code, msg } = err.data.error_response;
      throw new AliExpressApiError(code, msg ?? "platform error");
    }
    return data;
  }
}
