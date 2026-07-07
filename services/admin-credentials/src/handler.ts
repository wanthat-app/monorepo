/**
 * Admin credentials service — the write-only retailer-credential drop, split out of admin-api
 * because it must run **outside** the VPC: Secrets Manager is only reachable over its public
 * endpoint, and the VPC is deliberately endpoint-free (ADR-0004; the SM interface endpoint was
 * removed once nothing in the VPC read secrets). Same admin HTTP API, same JWT authorizer, same
 * in-handler admin-group re-check as admin-api; this function's role holds PutSecretValue +
 * DescribeSecret only, so the credential can be written but never read back. retailer-proxy
 * (also non-VPC) stays the sole reader.
 */
import { PutRetailerCredentialsBody, RetailerCredentialsStatus } from "@wanthat/contracts";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { getContext } from "./context";
import { type Bindings, requireAdmin } from "./guard";

const SERVICE = "admin-credentials";

const app = new Hono<{ Bindings: Bindings }>();

app.use("/admin/*", requireAdmin);

// GET /admin/retailer/aliexpress/credentials — write-only credential status: whether the secret
// has been written and when. Never returns (or can return) the credential values themselves.
app.get("/admin/retailer/aliexpress/credentials", async (c) =>
  c.json(RetailerCredentialsStatus.parse(await getContext().retailerSecret.status())),
);

// PUT /admin/retailer/aliexpress/credentials — replace the AliExpress AppKey/AppSecret pair in the
// retailer secret (both fields together; PutSecretValue replaces the whole value). The body is
// never logged and never echoed back — errors name the failing field, not its content.
app.put("/admin/retailer/aliexpress/credentials", async (c) => {
  const body = PutRetailerCredentialsBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    const fields = [...new Set(body.error.issues.map((i) => i.path.join(".") || "body"))];
    return c.json({ error: "invalid_request", fields }, 400);
  }
  await getContext().retailerSecret.put(body.data);
  // Re-describe rather than fabricating a timestamp, so PUT and GET report the same clock.
  return c.json(RetailerCredentialsStatus.parse(await getContext().retailerSecret.status()));
});

app.all("*", (c) => c.json({ error: "not_implemented", service: SERVICE, path: c.req.path }, 501));

export const handler = handle(app);
export { app };
