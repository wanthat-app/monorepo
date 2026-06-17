# ADR 0004 — SMS-only OTP + passkeys (WhatsApp deferred), with an SMS-abuse kill switch

- **Status:** Accepted
- **Date:** 2026-06-17
- **Context refs:** Solution Design Document §7, §7.5, §5.1, §13, §17, §18 #2, §18 #10; AWS Architecture (MVP) §3.2
- **Revises:** SDD §18 #2 (was: WhatsApp-first OTP, SMS fallback)

## Context

§18 #2 chose WhatsApp-first OTP (SMS fallback). But WhatsApp is **not** a native Cognito
channel — it forces the Custom Auth Challenge flow (Define/Create/Verify Lambdas) where we
own OTP generation, expiry, throttling and lockout (contradicting §7.1's "Cognito handles
…"), plus an external Meta/WABA business-verification + template-approval dependency that
would gate *all* sign-up and isn't tracked in §17. The cost upside of WhatsApp is also
secondary: §18 #10 already identifies **passkeys** as the real repeat-login cost killer
(they send no SMS).

## Decision

**Drop WhatsApp for MVP.** Identity uses:

- **SMS OTP** (native Cognito passwordless, choice-based `ALLOW_USER_AUTH`, Essentials tier)
  for registration, first sign-in, recovery, and new-device fallback.
- **Passkeys/WebAuthn** (native Cognito, Essentials tier) offered as an opt-in step-up after
  the first sign-in; carries steady-state repeat logins with no SMS.

WhatsApp becomes a later, additive channel (abstract the OTP send channel so it can be added
without restructuring).

This makes §7.1 accurate again (native SMS OTP → Cognito owns generation/expiry/throttle),
removes the 3 custom-auth Lambdas, and shrinks the identity stack to: Cognito pool (native
SMS OTP + passkeys) + Post-Confirmation provisioning trigger.

## Region verification (il-central-1)

- Cognito GA in `il-central-1` since Sept 2023.
- Passwordless SMS OTP (`ALLOW_USER_AUTH`) and passkeys require the **Essentials/Plus** tier;
  those tiers are available in **all** regions where Cognito is available, and `il-central-1`
  is specifically listed for Essentials/Plus. **→ both features available in Tel Aviv.**
- **Confidence: high.** Do a build-time sanity check (create a pool in `il-central-1`, enable
  `ALLOW_USER_AUTH` + passkeys) before relying on it.
- **Caveat (feeds DR / ADR on #6):** Cognito **multi-Region replication is NOT available in
  `il-central-1`** — the `eu-central-1` fallback cannot use native Cognito replication for
  identity.

## SMS-abuse kill switch (layered)

Enabler: our own `/auth/*` API fronts Cognito (`InitiateAuth`), so we gate *before* any SMS
is sent even with native passwordless.

1. **Prevent:** per-phone velocity (DynamoDB counter + TTL, N/phone/hour & /day) checked in
   the `/auth` handler; per-IP / per-subnet WAF rate rules on `/auth/*`; enumeration-safe
   (uniform response, **no OTP to unknown numbers** — §7.5); optional geo-match (Israel-first).
2. **Detect:** CloudWatch alarms on SNS SMS send-rate spike and `SMSMonthToDateSpentUSD` →
   page ops (§13 "alert on OTP send spike").
3. **Switch (auto + manual):** SSM Parameter / AppConfig flag `auth/otp_sms_enabled` checked
   in the `/auth` handler before calling Cognito; flip → SMS OTP stops instantly (degrade to
   passkey-only / try-later). Detect-alarm can trip it via a small Lambda; ops can flip it by
   hand.
4. **Hard cap (fail-safe):** SNS `MonthlySpendLimit` per environment — once month-to-date SMS
   spend hits the cap, SNS stops sending regardless. Blunt (blocks legit users once tripped;
   raising the default may need an AWS support request) → set deliberately, with the layer-2
   alarm well below it.

## Consequences

- SMS is the sole first-touch channel **and** the top abuse surface; the kill switch above
  plus rate limits move from optional to **launch-required**.
- Israeli SMS may need a **registered sender ID / origination** setup (lead time) — start early.
- Cost: SMS dominant on first-touch + recovery only; passkeys carry repeat logins (§5.1 / §18
  #10 reasoning holds without WhatsApp).
- §17 risk register: WhatsApp dependency removed; SMS-pumping mitigation now rests on the
  kill switch + rate limits.
