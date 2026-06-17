/**
 * Signed AliExpress Affiliate client. Uses the System Interface gateway
 * (api-sg.aliexpress.com/sync) with HMAC-SHA256 — NOT the legacy MD5 gw.api.taobao.com
 * gateway (SDD Appendix A). Covers link.generate (link gen) and order.listbyindex
 * (conversion poller, ADR-0002).
 *
 * Stub — signing + HTTP calls land with the links module / poller.
 */

export const ALIEXPRESS_GATEWAY = "https://api-sg.aliexpress.com/sync";

export interface RetailerAdapter {
  id: "aliexpress";
  matches(url: URL): boolean;
  /** Network commission window in days (AliExpress = 3). */
  attributionWindowDays: number;
  generate(
    url: string,
    subId: string,
  ): Promise<{ affiliateUrl: string; productName?: string; imageUrl?: string }>;
}

/** Params for aliexpress.affiliate.order.listbyindex (time-window + cursor, GMT+8). */
export interface OrderListByIndexParams {
  startTime: string; // "yyyy-MM-dd HH:mm:ss", GMT+8
  endTime: string; // "yyyy-MM-dd HH:mm:ss", GMT+8
  status: string;
  startQueryIndexId?: string;
  pageSize?: number;
}
