# WhatsApp messaging MVP — design (ADR-0023)

- **Date:** 2026-07-02 (rev 2 — separation-of-concerns review)
- **Implements:** [ADR-0023](../../../adrs/0023-whatsapp-messaging-capability.md) (decision + rationale live there; this doc is the execution design)
- **Scope (user decision):** the two MVP use cases — OTP over WhatsApp and the `optin_welcome`
  message on registration. Delivery-status webhooks / opt-out handling are deferred.
- **Ship state:** everything lands kill-switched OFF. WhatsApp onboarding (Meta business
  verification + template approval) has not happened; behavior changes only when config keys are
  flipped post-onboarding. No redeploy needed to launch.

## Design principle: strict separation of concerns

Each layer does one job; ambiguity is rejected, not absorbed:

- **Executors** (`services/message-sender`, `@wanthat/whatsapp`) send via exactly the requested
  channel/template **or fail**. No defaults, no fallbacks, no kill-switch reads, no degrading.
- **Flow controllers** (app-auth for OTP, the dispatcher for notifications) validate channel
  availability up front and surface executor failures as explicit errors. They never silently
  switch channels.
- **The UI** owns choice and recovery: it learns available channels from config, preselects the
  default, and offers "send via SMS instead" when WhatsApp fails or is unavailable.

## Slicing

Two vertical, independently deployable PRs (per the deployable-use-case-slice convention — the
ADR's original layered 7-PR sequence is superseded by this):

1. **PR 1 — "Sign in with OTP over WhatsApp"**: contracts + config keys + `@wanthat/whatsapp` +
   `message-sender` service + IdentityStack wiring + SPA channel toggle.
2. **PR 2 — "Welcome message on registration"**: `notification_outbox` table + repo +
   `WhatsAppStack` dispatcher + `app-core` producer (backend-only slice, but a complete use case
   end to end).

## PR 1 — OTP over WhatsApp

### Contracts (`packages/contracts`)

- `OtpChannel = z.enum(["whatsapp", "sms"])` and `MessageLanguage = z.enum(["he", "en"])` in
  `identity/auth.ts`.
- `AuthStartBody` and `AuthResendBody` gain **required** `channel: OtpChannel`. No server-side
  default: the UI picks the channel (from `/auth/config`) and states it explicitly. The resend
  screen's "send via SMS instead" is the same field on resend.
- **New `GET /auth/config`** → `AuthConfigResponse { channels: OtpChannel[], defaultChannel:
  OtpChannel }` — the enabled channels and the preselect, computed from runtime config. This is
  how the UI controls the flow without hardcoding availability (pre-onboarding it returns
  `channels: ["sms"]`, so the WhatsApp option simply doesn't render).
- `AuthStartResponse` / resend response gain `channel: OtpChannel` — echo of the channel used,
  so the SPA renders "code sent via WhatsApp" truthfully.
- Error contract additions: `channel_disabled` (503, requested channel not available) and
  `send_failed` (502, the sender failed to submit the message) — both carry `channel`.
- New runtime-config keys in `config/keys.ts`:
  | Key | Type | Default |
  | --- | --- | --- |
  | `auth.whatsappEnabled` | boolean | `false` |
  | `auth.defaultOtpChannel` | `"whatsapp" \| "sms"` | `"whatsapp"` |
  | `whatsapp.phoneNumberId` | string | `""` |
  `whatsapp.phoneNumberId` is the AWS End User Messaging Social origination identity, unknown
  until onboarding; runtime config (not SSM — a deliberate execution-level deviation from the
  ADR's consequences wording; the decision "runtime-flippable, no redeploy" is what's honored).
  **WhatsApp availability** = `auth.whatsappEnabled && whatsapp.phoneNumberId !== ""` — one
  shared predicate used by `/auth/config` and the start/resend gates.

### `packages/whatsapp` (new pure library)

Shaped like `@wanthat/dynamo`: constructed with an SDK client, no Lambda/runtime assumptions,
**no config reads** — callers pass `phoneNumberId` in.

- **Client wrapper** over `@aws-sdk/client-socialmessaging` `SendWhatsAppMessageCommand`
  (Meta Cloud API message JSON, `metaApiVersion` pinned).
- **Message-type registry** — the code-side source of truth (Meta is the approval authority):
  logical type → per-language Meta template name, category, and Zod variable schema.
  PR 1 registers `otp_code` (authentication category, languages `he`/`en`, variable: the code).
  PR 2 adds `optin_welcome`.
- **Payload builder**: `(type, language, variables, toPhoneE164, phoneNumberId)` → validated
  command input. Unknown type, unsupported language, or failed variable validation **throws** —
  no fallback variants. Send-submission errors from the SDK propagate to the caller.

### `services/message-sender` (new, non-VPC, Cognito-invoked)

Cognito Custom SMS Sender trigger (`CustomSMSSender_*` events). **Once attached, Cognito never
sends SMS natively again — this Lambda owns all OTP delivery**, including plain SMS.

A pure executor — send via the requested channel or fail. Per invocation:

1. Decrypt `request.code` (KMS `Decrypt`; Cognito encrypts with the customer-managed key
   configured as `customSenderKmsKey`).
2. Channel = `userAttributes["custom:otpChannel"]`. Missing or invalid → **throw** (app-auth
   writes it on every start/resend; absence is an invariant violation, not a case to paper over).
3. `whatsapp` → read `whatsapp.phoneNumberId` from runtime config (a send parameter, not flow
   logic; it cannot arrive via the Cognito event). Empty → **throw**. Send the `otp_code`
   template via `@wanthat/whatsapp`; language = `userAttributes["locale"]` if `he`/`en`, else
   `en`. Any send error → **throw**.
4. `sms` → SNS `Publish` to the phone number, transactional, message text matching the current
   Cognito OTP wording (8-digit code). Any error → **throw**.

No kill-switch reads, no channel defaults, no WhatsApp→SMS fallback. A throw propagates to the
initiating Cognito API call (`AdminInitiateAuth` fails with `UnexpectedLambdaException` — user
pool triggers are invoked synchronously), which is exactly how app-auth learns the send failed.

### `services/app-auth` (the OTP flow controller)

- **`GET /auth/config`**: returns enabled channels (`sms` iff `auth.smsEnabled`; `whatsapp` iff
  the availability predicate) and `defaultChannel` (= `auth.defaultOtpChannel` when available,
  else the first enabled channel).
- **`/auth/start`**: validate `channel` against the same predicate — requested channel not
  available → **503 `channel_disabled`** (no silent switching). Write `custom:otpChannel` via
  `AdminUpdateUserAttributes` (new `cognito.ts` method `setOtpChannel`) **before**
  `startSmsOtp`. `AdminInitiateAuth` failing on a sender throw → **502 `send_failed`** with the
  channel (no challenge record is written; nothing to clean up). Store `requestedChannel` on the
  challenge record; echo `channel` in the response. Velocity gates unchanged.
- **`/auth/resend`**: same validation with the request's `channel` (this is the UI's
  "send via SMS instead" path — an explicit user decision, not a server fallback); update the
  attribute, re-initiate, persist the new `requestedChannel`, echo it.
- The existing `smsEnabled` 503 gate becomes the `sms` arm of the per-channel gate.

**Failure semantics (honest limitation):** the synchronous fail covers **send-submission**
errors (invalid phone-number ID, unapproved/unknown template, throttling, malformed payload).
`SendWhatsAppMessage` succeeds when Meta *accepts* the message; recipient-level delivery
failures — including "this number is not on WhatsApp" — are reported asynchronously by Meta and
cannot fail `/auth/start`. Until the deferred webhook slice lands, that case is covered by the
UI: the code screen's "send via SMS instead" resend. This is the ADR's accepted optimistic-send
tradeoff, now narrowed to delivery-only (submission errors fail loudly).

### Infra (`infra/lib/identity-stack.ts`)

- `custom:otpChannel` mutable string attribute on the customer pool (additive — no pool
  replacement).
- Customer-managed KMS key (rotation on) as `customSenderKmsKey`.
- `NodejsFunction` for `message-sender` (non-VPC, 256 MB, 10 s, active tracing, log group per
  existing convention) + `userPool.addTrigger(UserPoolOperation.CUSTOM_SMS_SENDER, fn)`.
- Grants: KMS decrypt, `sns:Publish` (SMS), `social-messaging:SendWhatsAppMessage`,
  runtime-config table read (table name via env var from DataStack props).
- app-auth's role gains `cognito-idp:AdminUpdateUserAttributes` on the customer pool.

### SPA (`apps/web`)

- Phone screen: fetch `/auth/config`; render the channel toggle from `channels` (single channel →
  no toggle), preselect `defaultChannel`; send the selection as `channel` on `/auth/start`
  (i18n he/en).
- `/auth/start` fails with `send_failed`/`channel_disabled` for whatsapp → inline error with a
  "Try SMS instead" action (a fresh `/auth/start` with `channel: "sms"` — no challenge exists).
- Code screen: "sent via WhatsApp/SMS" from the response `channel`; when the active channel is
  whatsapp, secondary action "Didn't get it? Send via SMS" → `/auth/resend` with
  `channel: "sms"`.

### PR 1 risk note

This PR touches the live login path even with WhatsApp off: after deploy, SMS OTP is delivered
by our Lambda (SNS publish) instead of Cognito-native SMS, and a sender failure now fails
`/auth/start` loudly (by design — previously Cognito absorbed SNS errors). Mitigations: the SMS
branch replicates current behavior (same SNS transactional publish, same 8-digit code), hard
unit coverage on the sender, and a dev smoke test that verifies both the happy path and that a
forced sender throw surfaces as `send_failed` (confirming the `UnexpectedLambdaException`
propagation). Dev SMS budget: ~$0.13 left in the July sandbox cap (~2 test sends).

## PR 2 — `optin_welcome` on registration

### Data

- `notification_outbox` DynamoDB table in **DataStack** (with the other tables): PK `outboxId`
  (UUID), on-demand, TTL attribute `ttl` (30 days), PITR per existing convention, **Streams
  NEW_IMAGE**. No GSI in MVP (YAGNI — nothing queries by customer yet).
- `NotificationOutboxRepo` in `packages/dynamo` (pattern: existing repos): `put(item)`,
  `get(outboxId)`, `markSent(outboxId)`, `markFailed(outboxId, error)`.
  Item: `outboxId`, `customerId`, `phone` (E.164 destination), `messageType`
  (`"optin_welcome"`), `language` (`he`/`en`), `variables` (record),
  `status: "pending" | "sent" | "failed"`, `createdAt`, `ttl`.

### Producer (`services/app-core`)

In `/auth/register`, after `insertCustomer` succeeds: write one outbox item — `language` from
the customer's profile locale (`en` when absent), variables: first name + app URL — over the
DynamoDB gateway endpoint. The producer decides *what* to send and in which language; the
dispatcher and library do not re-derive it. Outbox write failure is logged but does **not**
fail registration (welcome message is best-effort). Registration also syncs the customer's
locale to the Cognito `locale` attribute, so subsequent OTP messages use the profile language.
Context gains the repo; ApiStack passes `NOTIFICATION_OUTBOX_TABLE` + grants write to the
app-core role.

### `WhatsAppStack` (new, instantiated after Data; no VPC dependency)

- **`whatsapp-dispatcher`** — **non-VPC** `NodejsFunction` (ADR-0023's NAT-free bridge: in-VPC
  producers write DynamoDB over the free gateway endpoint; the non-VPC dispatcher does the
  public-endpoint egress). DynamoDB event source on the outbox stream: batch 10, retry 3, bisect
  on error, **on-failure destination → SQS DLQ** (14-day retention).
- The dispatcher is the **flow controller** of the async notification flow (there is no higher
  level — no user is present). Per INSERT record: skip unless `status === "pending"`; when
  `notifications.whatsappEnabled` is false or `whatsapp.phoneNumberId` is empty, skip and leave
  `pending` (pre-launch items age out via TTL — intended); otherwise build the payload
  (`optin_welcome`, the item's language/variables, `phoneNumberId` passed into the pure library)
  and send; `markSent` on success, `markFailed(error)` on a throw. At-least-once + idempotent on
  `outboxId` via the status check (ADR-accepted tradeoff).
- New key `notifications.whatsappEnabled` (boolean, default `false`).
- Grants: outbox stream read + table update, runtime-config read,
  `social-messaging:SendWhatsAppMessage`.
- Stack order: `Network → Data → Identity → Api/Admin/EdgeServices → WhatsApp → Edge →
  Observability` (WhatsApp needs only Data).

### Registry addition

`optin_welcome` (utility category, he/en): greeting with first name + link to the app.
Template body text lives in the onboarding runbook for Meta submission; the registry holds
name/category/variable schema.

## Kill-switch matrix (launch state → flipped)

| Key | Ships as | Post-onboarding | Consumed by |
| --- | --- | --- | --- |
| `auth.smsEnabled` | `true` (existing) | `true` | app-auth gate + `/auth/config` |
| `auth.whatsappEnabled` | `false` | `true` | app-auth gate + `/auth/config` |
| `auth.defaultOtpChannel` | `"whatsapp"` (inert while disabled) | `"whatsapp"` | `/auth/config` → UI preselect |
| `notifications.whatsappEnabled` | `false` | `true` | dispatcher |
| `whatsapp.phoneNumberId` | `""` | the EUM Social phone-number ID | availability predicate, message-sender, dispatcher |

## Testing

- `packages/whatsapp`: registry lookup, payload builder (valid/invalid variables, unsupported
  language/type throws), client wrapper with mocked SDK.
- `services/message-sender`: missing/invalid `custom:otpChannel` throws; empty `phoneNumberId`
  throws; WhatsApp submission error throws (no SMS fallback); SMS branch message format; KMS
  decrypt mocked.
- `services/app-auth` router tests: `/auth/config` matrix (switch combinations), required
  `channel` validation, `channel_disabled` per channel, `send_failed` mapping on initiate
  failure, attribute write ordering, resend channel switch.
- `services/app-core` register test: outbox write on success, registration survives outbox
  failure, locale sync.
- Dispatcher: pending/skip/sent/failed paths, disabled-config skip leaves `pending`, idempotent
  re-delivery.
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
`auth.whatsappEnabled` (UI starts offering WhatsApp within the config cache window), then
`notifications.whatsappEnabled`. Rollback = flip back; no redeploys in either direction.
