import { createHmac } from "node:crypto";

/**
 * HMAC-SHA256 signature for the System Interface gateway (SDD Appendix A): sort all params
 * except `sign` by key ASCII-ascending, concatenate `key+value` with no separators, HMAC with
 * the app secret, hex **uppercase**. The legacy MD5 gateway is deliberately not implemented.
 */
export function signParams(params: Record<string, string>, appSecret: string): string {
  const base = Object.keys(params)
    .filter((key) => key !== "sign")
    .sort()
    .map((key) => key + params[key])
    .join("");
  return createHmac("sha256", appSecret).update(base).digest("hex").toUpperCase();
}
