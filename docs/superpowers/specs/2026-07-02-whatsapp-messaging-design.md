# WhatsApp messaging MVP — design (ADR-0023)

- **Date:** 2026-07-02
- **Implements:** [ADR-0023](../../../adrs/0023-whatsapp-messaging-capability.md) (decision + rationale live there; this doc is the execution design)
- **Scope (user decision):** the two MVP use cases — OTP over WhatsApp and the `optin_welcome`
  message on registration. Delivery-status webhooks / opt-out handling are deferred.
- **Ship state:** everything lands kill-switched OFF. WhatsApp onboarding (Meta business
  verification + template approval) has not happened; behavior changes only when config keys are
  flipped post-onboarding. No redeploy needed to launch.

## Slicing

Two vertical, independently deployable PRs (per the deployable-use-case-slice convention — the
ADR's original layered 7-PR sequence is superseded by this):

1. **PR 1 — "Sign in with OTP over WhatsApp"**: contracts + config keys + `@wanthat/whatsapp` +
   `custom-sms-sender` service + IdentityStack wiring + SPA channel toggle.
2. **PR 2 — "Welcome message on registration"**: `notification_outbox` table + repo +
   `WhatsAppStack` dispatcher + `app-core` producer + SPA-visible nothing (backend-only slice, but
   a complete use case end to end).

## PR 1 — OTP over WhatsApp

### Contracts (`packages/contracts`)

- `OtpChannel = z.enum(["whatsapp", "sms"])` in `identity/auth.ts`.
- `AuthStartBody` and `AuthResendBody` gain optional `channel: OtpChannel` — the resend screen's
  "send via SMS instead" is the same field on resend.
- `AuthStartResponse` (and resend response) gain `channel: OtpChannel` — the channel actually
  requested, so the SPA can render "code sent via WhatsApp" truthfully (optimistic send; final
  delivery is async per ADR-0023).
- New runtime-config keys in `config/keys.ts`:
  | Key | Type | Default |
  |---|---|---|
  | `auth.whatsappEnabled` | boolean | `false` |
  | `auth.defaultOtpChannel` | `"whatsapp" \| "sms"` | `"whatsapp"` |
  | `whatsapp.phoneNumberId` | string | `""` |
  `whatsapp.phoneNumberId` is the AWS End User Messaging Social origination identity, unknown
  until onboarding; runtime config (not SSM, a deliberate execution-level deviation from the
  ADR's consequences wording — the decision "runtime-flippable, no redeploy" is what's honored).
  Empty string = WhatsApp inert regardless of other switches.

### `packages/whatsapp` (new pure library)

Shaped like `@wanthat/dynamo`: constructed with an SDK client, no Lambda/runtime assumptions.

- **Client wrapper** over `@aws-sdk/client-socialmessaging` `SendWhatsAppMessageCommand`
  (Meta Cloud API message JSON, `metaApiVersion` pinned).
- **Message-type registry** — the code-side source of truth (Meta is the approval authority):
  logical type → per-language Meta template name, category, and Zod variable schema.
  PR 1 registers `otp_code` (authentication category, languages `he`/`en`, variable: the code).
  PR 2 adds `optin_welcome`.
- **Payload builder**: (type, language, variables, toPhoneE164, phoneNumberId) → validated
  `SendWhatsAppMessageCommand` input. Unknown type / failed variable validation / unsupported
  language falls back to `en` template variant; throws on unknown type (caller decides fallback).

### `services/custom-sms-sender` (new, non-VPC, Cognito-invoked)

Cognito Custom SMS Sender trigger (`CustomSMSSender_*` events). **Once attached, Cognito never
sends SMS natively again — this Lambda owns all OTP delivery**, including plain SMS.

Flow per invocation:
1. Decrypt `request.code` (KMS `Decrypt`; Cognito encrypts with the customer-managed key
   configured as `customSenderKmsKey`).
2. Resolve channel: `userAttributes["custom:otpChannel"]` if valid, else `auth.defaultOtpChannel`.
3. Gates: channel `whatsapp` requires `auth.whatsappEnabled === true` **and**
   `whatsapp.phoneNumberId !== ""`; otherwise degrade to `sms`.
4. WhatsApp send via `@wanthat/whatsapp` (`otp_code`, language from `custom:locale` if present
   else `he`). On any send-submission error: **fall back to SMS in-Lambda**.
5. SMS send = direct SNS `Publish` to the phone number, transactional, message text matching the
   current Cognito OTP wording (8-digit code). The account-level SMS spend cap still applies.
6. `auth.smsEnabled === false` + channel degraded to sms → log + drop (the existing `/auth/start`
   gate already 503s before this point; this is defense in depth, not a user-facing path).

Errors never propagate to Cognito in a way that fails the auth flow silently — log with enough
context (channel, fallback reason) for observability; optimistic-send UX is the accepted ADR
tradeoff.

### `services/app-auth`

- `/auth/start`: resolve effective channel = `body.channel ?? auth.defaultOtpChannel`; when
  WhatsApp is disabled by config, force `sms`. Write `custom:otpChannel` via
  `AdminUpdateUserAttributes` (new `cognito.ts` method `setOtpChannel`) **before**
  `startSmsOtp`; store `requestedChannel` on the challenge record; echo `channel` in the response.
- `/auth/resend`: same resolution with `body.channel` overriding the stored `requestedChannel`
  (this is the "send via SMS" path); update the attribute, re-initiate, persist the new
  `requestedChannel`.
- The `smsEnabled` 503 gate stays as the "all OTP off" master switch (its meaning today);
  channel-level gating is the new keys' job.

### Infra (`infra/lib/identity-stack.ts`)

- `custom:otpChannel` mutable string attribute on the customer pool.
  (Adding a custom attribute is additive — no pool replacement.)
- Customer-managed KMS key (rotation on) as `customSenderKmsKey`.
- `NodejsFunction` for `custom-sms-sender` (non-VPC, 256 MB, 10 s, active tracing, log group per
  existing convention) + `userPool.addTrigger(UserPoolOperation.CUSTOM_SMS_SENDER, fn)`.
- Grants: KMS decrypt, `sns:Publish` (SMS), `social-messaging:SendWhatsAppMessage`,
  runtime-config table read (table name via env var, passed from DataStack props).
- app-auth's role gains `cognito-idp:AdminUpdateUserAttributes` on the customer pool.

### SPA (`apps/web`)

- Phone screen: WhatsApp/SMS segmented toggle, WhatsApp preselected
  (i18n strings he/en); selection sent as `channel` on `/auth/start`.
- Code screen: "sent via WhatsApp/SMS" line from the response `channel`; secondary action
  "Didn't get it? Send via SMS" → `/auth/resend` with `channel: "sms"` (shown only when the
  active channel is whatsapp).

### PR 1 risk note

This PR touches the live login path even with WhatsApp off: after deploy, SMS OTP is delivered by
our Lambda (SNS publish) instead of Cognito-native SMS. Mitigations: the SMS branch replicates
current behavior (same SNS transactional publish, same 8-digit code), hard unit coverage on the
sender, `pnpm synth` + dev deploy verification before prod. Dev SMS budget: ~$0.13 left in the
July sandbox cap (~2 test sends) — spend them on the post-deploy smoke test.

## PR 2 — `optin_welcome` on registration

### Data

- `notification_outbox` DynamoDB table in **DataStack** (with the other tables): PK `outboxId`
  (UUID), on-demand, TTL attribute `ttl` (30 days), PITR per existing convention, **Streams
  NEW_IMAGE**. No GSI in MVP (YAGNI — nothing queries by customer yet).
- `NotificationOutboxRepo` in `packages/dynamo` (pattern: existing repos): `put(item)`,
  `get(outboxId)`, `markSent(outboxId)`, `markFailed(outboxId, error)`.
  Item: `outboxId`, `customerId`, `phone` (E.164 destination), `messageType`
  (`"optin_welcome"`), `language`, `variables` (record), `status: "pending" | "sent" | "failed"`,
  `createdAt`, `ttl`.

### Producer (`services/app-core`)

In `/auth/register`, after `insertCustomer` succeeds: write one outbox item
(`language` = customer locale, variables: first name + app URL) over the DynamoDB gateway
endpoint. Outbox write failure is logged but does **not** fail registration (welcome message is
best-effort). Context gains the repo; ApiStack passes `NOTIFICATION_OUTBOX_TABLE` + grants
write to the app-core role.

### `WhatsAppStack` (new, instantiated after Data; no VPC dependency)

- **`whatsapp-dispatcher`** — **non-VPC** `NodejsFunction` (this is ADR-0023's NAT-free bridge:
  in-VPC producers write DynamoDB over the free gateway endpoint; the non-VPC dispatcher does the
  public-endpoint egress). DynamoDB event source on the outbox stream: batch 10, retry 3, bisect
  on error, **on-failure destination → SQS DLQ** (14-day retention).
- Dispatcher logic per record (INSERT events only): skip unless `status === "pending"`; skip
  (leave pending) when `notifications.whatsappEnabled` is false or `whatsapp.phoneNumberId` is
  empty; build payload from the registry (`optin_welcome`); send; `markSent` / `markFailed`.
  At-least-once + idempotent on `outboxId` via the status check (ADR-accepted tradeoff).
- Grants: outbox stream read + table update, runtime-config read,
  `social-messaging:SendWhatsAppMessage`.
- Stack order: `Network → Data → Identity → Api/Admin/EdgeServices → WhatsApp → Edge →
  Observability` (WhatsApp needs only Data).

### Registry addition

`optin_welcome` (utility category, he/en): greeting with first name + link to the app.
Template body text lives in the onboarding runbook for Meta submission; the registry holds
name/category/variable schema.

## Kill-switch matrix (launch state → flipped)

| Key | Ships as | Post-onboarding |
|---|---|---|
| `auth.smsEnabled` | `true` (existing) | `true` |
| `auth.whatsappEnabled` | `false` | `true` |
| `auth.defaultOtpChannel` | `"whatsapp"` (inert while disabled) | `"whatsapp"` |
| `notifications.whatsappEnabled` | `false` | `true` |
| `whatsapp.phoneNumberId` | `""` | the EUM Social phone-number ID |

## Testing

- `packages/whatsapp`: registry lookup, payload builder (valid/invalid variables, language
  fallback), client wrapper with mocked SDK.
- `services/custom-sms-sender`: channel resolution matrix (attribute × config × phoneNumberId),
  KMS decrypt mocked, WhatsApp-fails→SMS-fallback, SMS message format.
- `services/app-auth` router tests: channel default/override/disabled-forcing, attribute write
  ordering, resend channel switch.
- `services/app-core` register test: outbox write on success, registration survives outbox
  failure.
- Dispatcher: pending/skip/sent/failed paths, disabled-config skip, idempotent re-delivery.
- Infra: `pnpm synth` per env; `pnpm diff` before deploy (convention).

## Onboarding runbook (parallel critical path — user action)

Delivered as `docs/whatsapp-onboarding.md` in PR 1: Meta Business verification → WABA created and
linked in AWS End User Messaging Social console (il-central-1 availability check; fall back to
eu-central-1 for the Social endpoint if needed — SDK client region is configurable) → business
phone number + display name → submit `otp_code` (authentication) and `optin_welcome` (utility)
templates in he+en → on approval, set `whatsapp.phoneNumberId` and flip the switches via admin
config. Dev can use a Meta test number.

## Launch sequence

Merge PR 1 → merge PR 2 → onboarding completes → set `whatsapp.phoneNumberId` → flip
`auth.whatsappEnabled`, then `notifications.whatsappEnabled`. Rollback = flip back; no redeploys
in either direction.
