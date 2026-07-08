/**
 * Signed AliExpress Affiliate client (SDD Appendix A; ADR-0002/0004): HMAC-SHA256 on the
 * System Interface gateway (api-sg.aliexpress.com/sync) — NOT the legacy MD5 gw.api.taobao.com
 * gateway. Covers link.generate + productdetail.get (link gen); order.listbyindex params are
 * declared for the conversion poller slice. URL recognition is parse-only (SSRF-safe).
 */

export * from "./client";
export * from "./sign";
export * from "./url";
