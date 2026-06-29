# ADR 0006 — Identity & authentication: SMS OTP + passkeys, with an SMS-abuse kill switch

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0005](0005-disaster-recovery-posture.md) (Cognito replication limit feeds DR)
- **Refined by:** [ADR-0020](0020-auth-foundation.md) (kill switch moves to the DynamoDB `config` store; unified flow SMSes new numbers; `customer` provisioned at `/auth/register`)

## Context

The product is a passwordless Israeli consumer app needing registration, first sign-in,
recovery, and new-device flows. The identity provider is **Amazon Cognito**. The main design
question is the first-touch channel and how to contain SMS-pumping abuse, since SMS is metered
and a prime fraud target.

## Decision

Identity uses two native Cognito mechanisms (Essentials tier):

- **SMS OTP** — native passwordless, choice-based `ALLOW_USER_AUTH` — for registration, first
  sign-in, recovery, and new-device fallback. Cognito owns OTP generation, expiry, and throttle.
- **Passkeys / WebAuthn** — native, offered as an opt-in step-up after first sign-in; carries
  steady-state repeat logins with **no SMS**.

**Our own `/auth/*` API fronts Cognito** (`InitiateAuth`), so we can gate **before** any SMS is
sent even with native passwordless. WhatsApp is dropped for MVP; abstract the OTP send channel so
it can be added later without restructuring.

### SMS-abuse kill switch (layered)

1. **Prevent:** per-phone velocity (DynamoDB counter + TTL, N/phone/hour & /day) in the `/auth`
   handler; per-IP / per-subnet WAF rate rules on `/auth/*`; enumeration-safe (uniform response,
   no OTP to unknown numbers); optional geo-match (Israel-first).
2. **Detect:** CloudWatch alarms on SNS SMS send-rate spike and month-to-date SMS spend.
3. **Switch (auto + manual):** an SSM Parameter / AppConfig flag checked in `/auth` before
   calling Cognito; flipping it stops SMS OTP instantly (degrade to passkey-only / try-later).
   The detect-alarm can trip it via a small Lambda; ops can flip it by hand.
4. **Hard cap (fail-safe):** SNS `MonthlySpendLimit` per environment — a blunt backstop set
   deliberately above the layer-2 alarm.

### Region note

Cognito and the Essentials tier (passwordless SMS OTP + passkeys) are available in
`il-central-1`. **Cognito multi-Region replication is NOT available in `il-central-1`** — this
feeds the DR posture (ADR-0005): no native identity failover.

## Alternatives considered

- **WhatsApp-first OTP** — not a native Cognito channel; forces the Custom Auth Challenge flow
  (Define/Create/Verify Lambdas) where we'd own OTP generation/expiry/throttle, plus a Meta/WABA
  business-verification + template-approval dependency that gates all sign-up. Its cost upside is
  secondary to passkeys (which send no SMS). Deferred to a later additive channel.
- **Password authentication** — worse UX and a worse security posture (credential stuffing,
  resets) for a phone-first consumer app.
- **SMS OTP without the kill switch** — leaves SMS-pumping unmitigated; not launch-safe.

## Consequences

- SMS is the sole first-touch channel and the top abuse surface → the kill switch + rate limits
  are **launch-required**, not optional.
- Israeli SMS may need a **registered sender ID / origination** setup with lead time — start
  early.
- Passkeys carry repeat logins, keeping steady-state SMS cost low.
- Identity has no cross-region recovery in MVP (ADR-0005).
