/**
 * Redirect service (ADR-0001, ADR-0003). GET /p/{short_id}:
 *   1. resolve short_id -> affiliate_url (Postgres on the hot path; relaxed latency).
 *   2. branch on auth state: logged-in -> auto-301 (+ customer_id in custom_parameters);
 *      anonymous -> OG-tagged landing page (+ guestId cookie).
 *   3. emit the click OFF the 301 path via a structured console.log line (a CloudWatch
 *      Logs subscription ships it to Firehose) — never an awaited PutRecord (Lambda
 *      freezes after the response and would drop it).
 *
 * Stub.
 */
export const handler = async (): Promise<unknown> => {
  throw new Error("not implemented");
};
