/**
 * PROBE (diagnostic, read-only): does `aliexpress.affiliate.order.get` exist, and does it return an
 * order's CURRENT status by order_ids? This is the [A2] the by-id re-drive design depends on.
 *
 * Signs the gateway call exactly like the client's private call() (HMAC-SHA256, v2.0), against a
 * known order id, and dumps the raw response. Read-only.
 *
 *   AWS_REGION=il-central-1 RETAILER_SECRET_ARN=arn:... ORDER_IDS=1121635427126421 \
 *   pnpm tsx scripts/probe-order-get.ts
 *   # or APP_KEY=... APP_SECRET=... ORDER_IDS=... pnpm tsx scripts/probe-order-get.ts
 */
import { ALIEXPRESS_GATEWAY, RetailerCredentialsReader, signParams } from "@wanthat/aliexpress";

async function resolveCreds(): Promise<{ appKey: string; appSecret: string }> {
  if (process.env.APP_KEY && process.env.APP_SECRET) {
    return { appKey: process.env.APP_KEY, appSecret: process.env.APP_SECRET };
  }
  const arn = process.env.RETAILER_SECRET_ARN;
  if (!arn) throw new Error("provide APP_KEY + APP_SECRET, or RETAILER_SECRET_ARN with AWS creds");
  const creds = await new RetailerCredentialsReader(arn).get();
  if (!creds) throw new Error(`retailer secret at ${arn} is empty/unset`);
  return creds;
}

async function callMethod(
  method: string,
  business: Record<string, string>,
  appKey: string,
  appSecret: string,
): Promise<unknown> {
  const params: Record<string, string> = {
    ...business,
    app_key: appKey,
    method,
    v: "2.0",
    format: "json",
    sign_method: "sha256",
    timestamp: String(Date.now()),
  };
  params.sign = signParams(params, appSecret);
  const res = await fetch(ALIEXPRESS_GATEWAY, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { httpStatus: res.status, raw: text };
  }
}

async function main() {
  const { appKey, appSecret } = await resolveCreds();
  const orderIds = process.env.ORDER_IDS ?? "";
  if (!orderIds) throw new Error("set ORDER_IDS=<comma-separated order ids>");

  const trackingId = process.env.TRACKING_ID ?? "default";
  // Several param shapes — the gateway is picky about which combination scopes to a real row.
  const attempts: Array<[string, Record<string, string>]> = [
    [
      "order_ids + tracking_id + fields",
      {
        order_ids: orderIds,
        tracking_id: trackingId,
        fields: "order_id,order_status,paid_time,estimated_paid_commission",
      },
    ],
    ["order_ids + tracking_id (no fields)", { order_ids: orderIds, tracking_id: trackingId }],
    ["order_ids only (no fields)", { order_ids: orderIds }],
  ];
  for (const [label, business] of attempts) {
    console.log(`\n=== ${label} ===`);
    const data = await callMethod("aliexpress.affiliate.order.get", business, appKey, appSecret);
    console.log(JSON.stringify(data, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
