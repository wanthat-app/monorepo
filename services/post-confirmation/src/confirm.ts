import { randomUUID } from "node:crypto";
import { jerusalemDate, type NotificationOutboxItem } from "@wanthat/dynamo";

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
  outbox: { put(item: NotificationOutboxItem): Promise<void> };
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
  /** Structured log sink; `outboxId` correlates with the whatsapp-dispatcher's notification_* lines. */
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
 * Post-Confirmation side effects (ADR-0006 decision 7) — DynamoDB only, no Aurora:
 *
 * 1. Queue the `optin_welcome` WhatsApp message through the transactional outbox (ADR-0019),
 *    exactly as `/auth/register` did before registration became the public `SignUp` call.
 * 2. Claim the `guest_attribution` mapping (`guestId → sub`, ADR-0008/0020) when the confirming
 *    call carried a `guestId` in ClientMetadata.
 * 3. Increment the exact customer counter (`customerCounter` total, OpsCounters table) — the
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

  // ADR-0019: the producer owns WHAT to send and in which language; the non-VPC dispatcher does
  // the egress. TTL self-cleans (~30 days) items skipped while the notifications switch is off.
  const outboxId = randomUUID();
  try {
    const phone = attrs.phone_number;
    if (!sub || !phone) throw new Error("event carries no sub or phone_number");
    await deps.outbox.put({
      outboxId,
      customerId: sub,
      phone,
      messageType: "optin_welcome",
      language: messageLanguage(attrs.locale),
      variables: { firstName: attrs.given_name ?? "", appUrl: deps.appUrl },
      status: "pending",
      createdAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    });
    deps.log.info("optin_welcome_enqueued", { outboxId, customerId: sub });
  } catch (err) {
    deps.log.error("optin_welcome_enqueue_failed", {
      customerId: sub,
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
