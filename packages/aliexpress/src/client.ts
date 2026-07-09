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
      resp_code: z.union([z.string(), z.number()]).optional(),
      resp_msg: z.string().optional(),
      result: z
        .object({
          current_record_count: z.number().optional(),
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

/**
 * One order from order.listbyindex, normalized. Field names on the wire are integration-pending
 * (ADR-0009): the parser accepts the documented variants and never crashes on extras.
 */
export interface AliExpressOrder {
  orderId: string;
  /** Raw platform status (e.g. "Payment Completed") — mapping to ledger status is the caller's job. */
  status: string;
  /** Raw round-tripped custom_parameters (JSON string or null) — parsing is the caller's job. */
  customParameters: string | null;
  /** Estimated commission, integer minor units as a decimal string; null when absent/malformed. */
  commissionMinor: string | null;
  commissionCurrency: string | null;
  /** Raw platform timestamp (GMT+8), informational. */
  orderTimeGmt8: string | null;
}

export interface OrderListPage {
  orders: AliExpressOrder[];
  /** Cursor for the next page; null = no more pages. */
  nextQueryIndexId: string | null;
}

const OrderListResponse = z.object({
  aliexpress_affiliate_order_listbyindex_response: z.object({
    resp_result: z.object({
      resp_code: z.union([z.string(), z.number()]).optional(),
      resp_msg: z.string().optional(),
      result: z
        .object({
          orders: z
            .object({
              order: z.array(
                z
                  .object({
                    order_id: z.union([z.string(), z.number()]).optional(),
                    order_number: z.union([z.string(), z.number()]).optional(),
                    order_status: z.string().optional(),
                    custom_parameters: z.string().optional(),
                    estimated_paid_commission: z.union([z.string(), z.number()]).optional(),
                    paid_commission: z.union([z.string(), z.number()]).optional(),
                    order_commission: z.union([z.string(), z.number()]).optional(),
                    order_commission_currency: z.string().optional(),
                    paid_time: z.string().optional(),
                    order_time: z.string().optional(),
                  })
                  .passthrough(),
              ),
            })
            .optional(),
          next_query_index_id: z.union([z.string(), z.number()]).optional(),
          current_record_count: z.number().optional(),
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
   * in the settlement currency (USD), ship-to IL (Wanthat's market — region-scoped items are
   * invisible without it). Throws a typed empty_result carrying the gateway's resp_code/resp_msg.
   */
  async getProductDetail(productId: string, timeoutMs = 2500): Promise<AliExpressProductDetail> {
    const data = await this.call(
      "aliexpress.affiliate.productdetail.get",
      {
        product_ids: productId,
        target_currency: "USD",
        target_language: "EN",
        // Region-scoped items (e.g. Israel-market listings) answer EMPTY without a ship-to.
        country: "IL",
        tracking_id: this.options.trackingId,
      },
      timeoutMs,
    );
    const parsed = ProductDetailResponse.safeParse(data);
    // An unrecognized payload is NOT a definitive miss — never let it read as "no such product".
    if (!parsed.success)
      throw new AliExpressApiError(
        "malformed_result",
        "productdetail.get answered an unrecognized payload",
      );
    const respResult = parsed.data.aliexpress_affiliate_productdetail_get_response.resp_result;
    const product = respResult.result?.products?.product[0];
    if (!product) {
      const diagnostics = [
        respResult.resp_code !== undefined && `resp_code=${respResult.resp_code}`,
        respResult.resp_msg !== undefined && `resp_msg="${respResult.resp_msg}"`,
        respResult.result?.current_record_count !== undefined &&
          `records=${respResult.result.current_record_count}`,
      ].filter(Boolean);
      throw new AliExpressApiError(
        "empty_result",
        `productdetail.get returned no product${diagnostics.length ? ` (${diagnostics.join(", ")})` : ""}`,
      );
    }
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

  /**
   * aliexpress.affiliate.order.listbyindex — one page of orders in a GMT+8 time window
   * (ADR-0009). An empty window is a NORMAL answer (empty page, never a throw — unlike
   * link.generate); a malformed top-level payload throws typed, like productdetail.
   */
  async listOrdersByIndex(params: OrderListByIndexParams, timeoutMs = 8000): Promise<OrderListPage> {
    const business: Record<string, string> = {
      start_time: params.startTime,
      end_time: params.endTime,
      status: params.status,
      page_size: String(params.pageSize ?? 50),
      tracking_id: this.options.trackingId,
    };
    if (params.startQueryIndexId) business.start_query_index_id = params.startQueryIndexId;
    const data = await this.call("aliexpress.affiliate.order.listbyindex", business, timeoutMs);
    const parsed = OrderListResponse.safeParse(data);
    if (!parsed.success)
      throw new AliExpressApiError(
        "malformed_result",
        "order.listbyindex answered an unrecognized payload",
      );
    const result = parsed.data.aliexpress_affiliate_order_listbyindex_response.resp_result.result;
    const orders = (result?.orders?.order ?? []).flatMap((o): AliExpressOrder[] => {
      const id = o.order_id ?? o.order_number;
      if (id === undefined) return []; // an order we cannot key is unusable — skip, never crash
      const commission = o.estimated_paid_commission ?? o.paid_commission ?? o.order_commission;
      return [
        {
          orderId: String(id),
          status: o.order_status ?? "",
          customParameters: o.custom_parameters ?? null,
          commissionMinor: decimalToMinor(
            commission === undefined ? undefined : String(commission),
          ),
          commissionCurrency: commission !== undefined ? (o.order_commission_currency ?? "USD") : null,
          orderTimeGmt8: o.paid_time ?? o.order_time ?? null,
        },
      ];
    });
    const cursor = result?.next_query_index_id;
    return { orders, nextQueryIndexId: cursor === undefined ? null : String(cursor) };
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
