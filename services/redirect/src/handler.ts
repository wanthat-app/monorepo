/**
 * Redirect service (ADR-0001, ADR-0003, ADR-0007, ADR-0008). Cookieless; behind a CloudFront →
 * Lambda Function URL, not the JWT authorizer. Two steps:
 *   1. GET /p/{recommendationId} -> resolve in DynamoDB (single-digit-ms read, no VPC) and return
 *      a minimal OG-tagged landing page + bootstrap JS; emit an impression event.
 *   2. Client-driven resolve assembles custom_parameters onto the product-level affiliate URL —
 *      member (Bearer, offline JWKS) -> c=customer_id; guest (guestId from localStorage) -> g;
 *      neither -> login/signup/continue-as-guest. The resolve emits the click event.
 * Both funnel events are structured console.log lines a CloudWatch Logs subscription ships to
 * Firehose — never an awaited PutRecord (Lambda freezes after the response and would drop it).
 *
 * Stub.
 */
export const handler = async (): Promise<unknown> => {
  throw new Error("not implemented");
};
