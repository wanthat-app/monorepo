/**
 * Signed AliExpress Affiliate client (SDD Appendix A; ADR-0002/0004): HMAC-SHA256 on the
 * System Interface gateway (api-sg.aliexpress.com/sync) — NOT the legacy MD5 gw.api.taobao.com
 * gateway. Covers link.generate + productdetail.get (link gen) and order.listbyindex (the
 * conversion poll). URL recognition is parse-only (SSRF-safe). The credentials reader lives
 * here too (refactor PR-6): retailer-linkgen and retailer-settlement each hold the
 * secret-scoped credential, so the memoizing Secrets Manager reader is shared package code.
 */

export * from "./client";
export * from "./credentials";
export * from "./short-link";
export * from "./sign";
export * from "./url";
