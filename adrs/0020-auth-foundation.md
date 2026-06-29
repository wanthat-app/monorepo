# ADR 0020 — Auth foundation: registration provisioning, in-VPC Cognito egress, kill switch, unified flow

- **Status:** Accepted
- **Date:** 2026-06-29
- **Refines (in part):** [ADR-0004](0004-network-topology-nat-free-egress.md) (adds one in-VPC
  interface endpoint), [ADR-0006](0006-identity-sms-otp-and-passkeys.md) (kill-switch substrate +
  unknown-number handling)
- **Related:** [ADR-0002](0002-app-compute-topology.md), [ADR-0003](0003-datastore-aurora-and-dynamodb.md),
  [ADR-0007](0007-landing-path-and-latency.md) (cookieless Bearer)

## Context

Building UC1 (Onboard) and UC2 (Sign-in) turns the `app-api` `/auth/*` stubs into the real flow
against Cognito + Aurora and stands up the deferred Aurora/VPC. Implementation surfaced five
decisions that refine assumptions baked into the locked architecture ADRs. ADRs are immutable once
accepted, so these are recorded here and the affected records cross-link back; the refinements are
narrow (one VPC endpoint, the kill-switch substrate, and the unknown-number handling) so ADR-0004
and ADR-0006 stay **Accepted** rather than fully superseded.

## Decision

1. **No Cognito Post-Confirmation trigger; provision `customer` in `/auth/register`.**
   `customer.first_name`/`last_name` are `NOT NULL` and are only collected at `POST /auth/register`
   (after OTP verify), so a confirmation-time trigger fires too early to write a valid row. The
   `customer` row is instead inserted inside the `/auth/register` handler (single Aurora txn). The
   "authenticated vs registration_required" branch in `/auth/verify` is therefore decided by **"does
   a `customer` row exist for this Cognito `sub`?"**, removing the trigger→Aurora coupling and the
   VPC-attached-trigger cold-path entirely.

2. **The in-VPC Lambdalith calls Cognito over a `cognito-idp` interface VPC endpoint.** ADR-0004
   reasoned that nothing in-VPC needs egress; it did not anticipate `app-api` (in-VPC for Aurora)
   calling the Cognito control plane. This adds **one** interface endpoint (`com.amazonaws.
   il-central-1.cognito-idp`, already present in-region) — the only new paid endpoint. Aurora and
   DynamoDB remain reached via IAM auth and the free gateway endpoint respectively; no NAT.

3. **SMS kill switch lives in the DynamoDB `config` store, not SSM/AppConfig.** ADR-0006 proposed an
   SSM Parameter / AppConfig flag; reading SSM from the in-VPC Lambdalith would need a second
   interface endpoint. Instead a new runtime-config key **`auth.smsEnabled`** (`@wanthat/contracts`
   `CONFIG_SCHEMAS`/`CONFIG_DEFAULTS`) is read via `RuntimeConfigRepo` over the existing DynamoDB
   gateway endpoint before any Cognito SMS send. `@wanthat/config` `OTP_SMS_ENABLED` remains the
   boot-time default applied until the key is first written. The detect-alarm and manual ops flip
   target this key; the SNS `MonthlySpendLimit` hard cap (ADR-0006 layer 4) is unchanged.

4. **The unified flow may SMS a previously-unseen number** (refines ADR-0006's "no OTP to unknown
   numbers"). A phone with no Cognito user is created on the fly — `AdminCreateUser(MessageAction:
   SUPPRESS)` + `AdminSetUserPassword(random, Permanent)` → CONFIRMED — then the OTP is initiated, so
   `/auth/start` behaves identically for new and returning numbers. Enumeration-safety is preserved
   by a **uniform response shape and timing** rather than by withholding the SMS; abuse stays
   contained by the per-phone velocity counter, the `auth.smsEnabled` kill switch, the WAF rate rules
   on `/auth/*`, and the SNS spend cap (ADR-0006 layers 1–4, all retained). A scheduled cleanup
   removes profile-less CONFIRMED users (created by `/auth/start` probes that never registered).

5. **`customer.cognito_sub` is the stable Cognito↔customer link.** Phone is mutable and is the
   Cognito sign-in alias, so it is unsuitable as the join key. Migration `0002_auth.sql` adds
   `cognito_sub text NOT NULL` + a unique index; `/auth/register` inserts with `ON CONFLICT
   (cognito_sub) DO NOTHING` for idempotency under retries. **NOT NULL is deliberate (fail-fast):** a
   customer is always provisioned with its sub, so a missing one is a bug the DB rejects at INSERT
   (registration retries) rather than persisting an unlinkable PII row. Safe with no backfill because
   `0001` creates `customer` empty.

6. **Two Cognito pools, split by population — customers vs. employees.** Admins are company staff, not
   customers: different trust level, lifecycle, and auth method. Rather than one pool split by an
   `admin` group, staff get a **separate `employeePool`** — **no self-signup** (provisioned via
   `admin-create-user`), **email + mandatory TOTP MFA** (no SMS, so staff auth sits off the SMS-abuse
   surface the customer pool is hardened against), and its own Managed Login hosted UI. The admin API
   authorizer points at this pool, so a customer token **structurally cannot** reach `/admin` — a
   boundary, not just an in-handler group check (the in-handler `admin`-group check is kept as
   defence-in-depth). **First-admin bootstrap:** an operator with AWS access runs `admin-create-user`
   for the employee's email once, then `admin-add-user-to-group --group-name admin`; the employee sets
   a password and enrols TOTP on first hosted-UI login. No standing privilege, CloudTrail-audited.
   Doing this now (zero admins exist) avoids a later pool migration.

## Alternatives considered

- **Post-Confirmation trigger writing a placeholder `customer`** — would need nullable name columns
  or placeholder values, polluting the PII table and complicating the registered/unregistered
  distinction; rejected in favour of provisioning at `/auth/register`.
- **SSM/AppConfig kill switch (as ADR-0006 sketched)** — costs a second in-VPC interface endpoint for
  no functional gain over a DynamoDB key the app already reads; rejected on cost/simplicity.
- **Withholding OTP from unknown numbers** — leaks which numbers are registered via response/timing
  differences unless carefully equalised anyway, and complicates the single-call onboarding; rejected
  in favour of uniform responses + the existing abuse controls.
- **One pool, admins as an `admin` group** — couples privileged staff access to the customer pool's
  abuse surface, forces consumer SMS-OTP onto staff, and reduces the boundary to an in-handler claim
  check; rejected in favour of a separate employee pool (decision 6). Cheapest to split now, before
  any admin exists.

## Consequences

- One new paid VPC interface endpoint (`cognito-idp`); Aurora/DynamoDB access unchanged.
- `/auth/start` can create Cognito users → user-pool pollution from probing; mitigated by the
  scheduled profile-less-user cleanup and the velocity counter.
- The kill switch is now one `RuntimeConfigRepo` read on the hot `/auth/start` path (cheap, cached
  per-container) and is flippable from the admin config panel with no redeploy.
- `customer.cognito_sub` is the canonical identity join key for `/me` and all member-scoped reads.
- **Passkeys split by flow.** Enrolment is API-driven (`/auth/passkey/register/*`, authorised by the
  access token via Cognito `Start/CompleteWebAuthnRegistration`). Discoverable (userless) *login*
  cannot be done through the raw Cognito API — the `WEB_AUTHN` challenge in `USER_AUTH` requires a
  username — so it is served by **Managed Login** (hosted UI); the SPA opens it and completes the
  OAuth code + PKCE exchange in the browser, then carries the Bearer token like any other session.
  This keeps the in-VPC Lambdalith off the hosted-UI token endpoint (which the NAT-free network can't
  reach) and is the resolution of the PR4 reconciliation spike.
