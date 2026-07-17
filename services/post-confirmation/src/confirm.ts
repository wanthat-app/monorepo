import type { AuditWriteRequest, SendNotificationRequest } from "@wanthat/contracts";
import { jerusalemDate } from "@wanthat/dynamo";

/** The slice of Cognito's Post Confirmation event we consume. */
export interface PostConfirmationEvent {
  triggerSource: string;
  request: {
    userAttributes: Record<string, string | undefined>;
    /** Forwarded from the initiating ConfirmSignUp call's ClientMetadata (may be absent). */
    clientMetadata?: Record<string, string | undefined>;
  };
}

export interface ConfirmDeps {
  /** Fire-and-forget async invoke of notification-sender (InvocationType Event). */
  notifications: { send(request: SendNotificationRequest): Promise<void> };
  /** Fire-and-forget async invoke of audit-writer — the signup's user_registered audit row. */
  audit: { write(request: AuditWriteRequest): Promise<void> };
  guests: {
    /** Map `guestId → sub` if unclaimed (first-claim-wins). Returns true if this call created it. */
    claim(guestId: string, sub: string, claimedAt: string): Promise<boolean>;
  };
  /** The exact customer counter (`customerCounter` in the OpsCounters table). */
  counter: { incrementTotal(): Promise<void> };
  /** Daily signup counter (`signupsDaily#<date>`, OpsCounters) — the dashboard's signup trend. */
  metrics: { incrementDaily(metric: "signupsDaily", date: string): Promise<void> };
  /** Canonical SPA origin for links in outbound messages (env APP_URL). */
  appUrl: string;
  /** Structured log sink; `sub` correlates with notification-sender's notification_* lines. */
  log: {
    info(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
}

/**
 * Map the user's `locale` attribute (BCP-47, set at SignUp) to a message language. A missing locale
 * defaults to Hebrew — same Israeli-first default the deleted `/auth/register` applied when no
 * viewer country was known (ADR-0006 decision 7 moved this write here).
 */
function messageLanguage(locale: string | undefined): "he" | "en" {
  return (locale ?? "he-IL").startsWith("he") ? "he" : "en";
}

/**
 * Post-Confirmation side effects (ADR-0006 decision 7) — DynamoDB + async Lambda invokes, no
 * synchronous Aurora work:
 *
 * 1. Async-invoke notification-sender with the `optin_welcome` payload (the outbox + stream of
 *    ADR-0019 became a direct InvocationType=Event invoke; the sender owns the kill switch).
 * 2. Async-invoke audit-writer with the `user_registered` event — the signup row the admin
 *    activity feed renders (the audit log itself is only reachable from in-VPC functions).
 * 3. Claim the `guest_attribution` mapping (`guestId → sub`, ADR-0008/0020) when the confirming
 *    call carried a `guestId` in ClientMetadata.
 * 4. Increment the exact customer counter (`customerCounter` total, OpsCounters table) — the
 *    dashboard's users KPI.
 *    Because ONLY this trigger increments, the counter counts CONFIRMED customers; the users
 *    page's approximate whole-pool total (incl. UNCONFIRMED) deliberately keeps a wider scope.
 *
 * All steps are independently best-effort: each failure is logged and swallowed, and an earlier
 * failure still attempts the later steps. Nothing here may throw — a thrown error would fail
 * the user's ConfirmSignUp call, and none of these writes is worth blocking a confirmation over.
 *
 * Only `PostConfirmation_ConfirmSignUp` does work; other trigger sources (e.g.
 * `PostConfirmation_ConfirmForgotPassword`) are a no-op — the user already got their welcome.
 */
export async function handleConfirmation(
  deps: ConfirmDeps,
  event: PostConfirmationEvent,
): Promise<void> {
  if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") return;

  const attrs = event.request.userAttributes;
  const sub = attrs.sub;
  const phone = attrs.phone_number;

  // The producer owns WHAT to send and in which language; the non-VPC notification-sender does
  // the egress and the kill-switch decision. Event invoke: accepted-for-delivery, not delivered.
  try {
    if (!sub || !phone) throw new Error("event carries no sub or phone_number");
    await deps.notifications.send({
      messageType: "optin_welcome",
      phone,
      language: messageLanguage(attrs.locale),
      variables: { firstName: attrs.given_name ?? "", appUrl: deps.appUrl },
    });
    deps.log.info("optin_welcome_invoked", { customerId: sub });
  } catch (err) {
    deps.log.error("optin_welcome_invoke_failed", {
      customerId: sub,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // The signup audit row (user_registered): profile fields from the Cognito attributes; empty
  // strings are omitted (the AuditWriteRequest optionals are min(1)).
  try {
    if (!sub || !phone) throw new Error("event carries no sub or phone_number");
    await deps.audit.write({
      event: "user_registered",
      sub,
      phone,
      ...(attrs.given_name ? { firstName: attrs.given_name } : {}),
      ...(attrs.family_name ? { lastName: attrs.family_name } : {}),
      ...(attrs.email ? { email: attrs.email } : {}),
    });
    deps.log.info("signup_audit_invoked", { sub });
  } catch (err) {
    deps.log.error("signup_audit_invoke_failed", {
      sub,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ADR-0008: resolve a pre-registration guest to the member who just confirmed. First-claim-wins
  // inside the repo; `false` (already claimed) is a fine outcome, not an error.
  const guestId = event.request.clientMetadata?.guestId;
  if (guestId && sub) {
    try {
      const created = await deps.guests.claim(guestId, sub, new Date().toISOString());
      deps.log.info("guest_attribution_claimed", { guestId, sub, created });
    } catch (err) {
      deps.log.error("guest_attribution_claim_failed", {
        guestId,
        sub,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Exact customer counter: one confirmed signup = total + 1 (atomic ADD on the sentinel item).
  // Same best-effort contract as the steps above — a miss is logged LOUDLY as
  // customer_counter_drift (reconcile hint: recount confirmed users via paginated ListUsers)
  // but never blocks the confirmation.
  try {
    await deps.counter.incrementTotal();
    deps.log.info("customer_counter_incremented", { sub });
  } catch (err) {
    deps.log.error("customer_counter_drift", {
      op: "incrementTotal",
      sub,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Daily signup counter (dashboard trend): same best-effort contract — a miss only dents a
  // chart, never a confirmation.
  try {
    await deps.metrics.incrementDaily("signupsDaily", jerusalemDate());
  } catch (err) {
    deps.log.error("signup_daily_count_failed", {
      sub,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
