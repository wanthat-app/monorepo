# ADR 0019 — WhatsApp messaging capability (OTP + notifications), Custom SMS Sender + End User Messaging Social

- **Status:** Proposed (execution-ready; build in a later slice)
- **Date:** 2026-07-01
- **Refines:** [ADR-0006](0006-cognito-native-auth-and-pii.md) (delivers the alternate OTP
  channel it told us to leave room for)
- **Related:** [ADR-0006](0006-cognito-native-auth-and-pii.md)
  (Custom SMS Sender is a separate Cognito-invoked non-VPC Lambda), [ADR-0003](0003-datastore-aurora-and-dynamodb.md),
  [ADR-0004](0004-network-topology-nat-free-egress.md)

## Context

Israeli users reach WhatsApp far more reliably than SMS, and the account is stuck behind an SMS
sandbox ($1/month spend cap, sender-ID registration lead time). We want WhatsApp as a **reusable
messaging capability** — OTP first, then transactional notifications — not an OTP one-off. ADR-0006
explicitly left the OTP send-channel abstractable for exactly this.

## Decision

1. **Reusable package `@wanthat/whatsapp`** — a pure library (like `@wanthat/dynamo`): a wrapper over
   `@aws-sdk/client-socialmessaging` (`SendWhatsAppMessageCommand`), a **message-type registry**
   (logical type -> Meta template name / category / Zod variable schema; code is the source of truth,
   Meta the approval authority), a payload builder, and webhook parsers. Consumed by OTP and
   notifications alike.

2. **Backend: AWS End User Messaging Social** (native, in-account) over Twilio/provider — cheapest
   (~$0.0103/OTP for Israel: Meta auth template $0.0053 + AWS $0.005), keeps PII in-account.

3. **OTP delivery: Cognito Custom SMS Sender trigger.** A KMS-encrypted-code trigger (non-VPC,
   Cognito-invoked) intercepts the OTP Cognito would SMS and delivers it via WhatsApp, with **SMS
   fallback**. **WhatsApp is the default channel** (user decision), overridable per request. Optimistic
   send (no synchronous delivery error; the resend screen offers SMS). Channel is conveyed via a
   `custom:otpChannel` user attribute — set at `SignUp` (rides `UserAttributes`) or edited post-auth; the sender itself enforces the kill switches and falls back to an enabled channel (ADR-0006).

4. **Notifications: transactional outbox on DynamoDB Streams (NAT-free bridge).** In-VPC producers
   (app-core) write a `notification_outbox` item over the free DynamoDB gateway endpoint; a Stream
   triggers a **non-VPC `whatsapp-dispatcher`** that sends via `@wanthat/whatsapp`. No NAT, **no new
   paid interface endpoint** (the rejected alternative was SQS + an interface endpoint). At-least-once,
   idempotent on the outbox id.

5. **MVP scope (user decision): OTP + `optin_welcome` only.** `optin_welcome` = a welcome message in
   the member's **preferred language** with a **link to the app**, sent on registration. Other use
   cases (cashback_earned, withdrawal_confirmed, conversion_update) deferred.

6. **Runtime kill switches (admin-flippable, no redeploy):** `auth.whatsappEnabled`,
   `auth.defaultOtpChannel` (= `whatsapp` at launch), `notifications.whatsappEnabled` (+ existing
   `auth.smsEnabled`). Ship everything OFF; flip on after onboarding.

## Alternatives considered

- **SNS to send WhatsApp** — SNS has no WhatsApp channel, and Cognito's native SMS can't be rerouted;
  rejected (see Custom SMS Sender).
- **Full Custom Auth Challenge flow** — more control but a bigger rewrite; the Custom SMS Sender keeps
  the native `SMS_OTP` flow and just swaps delivery. Accepted the optimistic-send tradeoff.
- **SQS + interface VPC endpoint** for the in-VPC->non-VPC notification bridge — native DLQ/retry but a
  paid endpoint against the no-paid-endpoints direction (ADR-0006); DynamoDB-Streams outbox chosen.
- **Twilio Verify** — turnkey but ~$0.05/verification markup and a third-party PII processor.

## Consequences

- New package `@wanthat/whatsapp`; new `WhatsAppStack` (outbox table + Streams, `whatsapp-dispatcher`
  + `whatsapp-webhook` Lambdas, SNS/EventBridge event destinations, DLQ); IdentityStack gains a KMS key
  + the `customSmsSender` trigger on the customer pool.
- **Onboarding is the critical path** (start now, parallel to code): Meta Business verification, WABA +
  End User Messaging Social linkage, display-name + **authentication template** (and the utility
  `optin_welcome` template) approval, opt-in handling. `WHATSAPP_PHONE_NUMBER_ID` injected as an SSM
  param per env; dev can use a Meta test number.
- Removes the SMS-sandbox / $1-cap / sender-ID friction from the primary auth path.
