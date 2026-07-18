# Audit log PII removal + deleted-user admin flow — design

- **Date:** 2026-07-18
- **Status:** Approved (brainstorm 2026-07-18)
- **Touches:** `packages/contracts`, `packages/dynamo`, `services/post-confirmation`,
  `services/audit-writer`, `services/admin-console`, `services/admin-ledger-view`,
  `apps/admin`, `packages/db/migrations`, `infra/lib/admin-stack.ts` (grant narrowing),
  ADR-0006 (decision 8, edited in place under the pre-production exception)

## Problem

1. **Member PII in the audit log.** The `user_registered` audit payload writes `phone`,
   `firstName`, `lastName`, `email` into the hash-chained Aurora `audit_log` — an append-only,
   unrewritable store. ADR-0006 places all customer PII in Cognito user attributes; the audit
   log violates that. (Admin emails in the `actor` field are employee data and stay —
   explicitly acceptable.)
2. **User events are anonymous in the feed.** `user_deleted` / `user_disabled` /
   `user_enabled` / `user_signed_out` payloads already carry only `{sub, actor}`, but the feed
   mapper never lifts `sub`, so the activity UI cannot show or link the affected member.
3. **Deleted users are a dead end in the admin console.** `UserDetailView` renders a single
   "not found" line on a Cognito 404, hiding the wallet data (Aurora, survives deletion) and
   recommendations. Worse, `cognito-delete` erases the user's recommendations
   (`deleteByOwner`), so post-deletion there is nothing to inspect.

## Decisions (settled in brainstorm)

- **Keep recommendations on delete.** Account deletion removes the Cognito account only; the
  member's recommendations (non-PII: sub + product data) are retained. A separate explicit
  "erase data" action can be added later for privacy requests. This edits ADR-0006 decision 8.
- **Scrub history by migration.** Existing `user_registered` rows are rewritten PII-free and
  the hash chain is recomputed end-to-end (the log is tiny; a full re-chain is trivial).
- **Feed shows resolved names, uuid as fallback.** User events reuse the existing
  `wallet_entry` pattern: live name/phone resolved via the users API while the account exists,
  shortened uuid once deleted — always linked to `/users/{sub}`.

## Design

### 1. Contracts (`packages/contracts/src/audit/write.ts`, `identity/admin-users.ts`)

- `UserRegisteredAudit` → `{ event: "user_registered", sub: Uuid }`. The
  `phone`/`firstName`/`lastName`/`email` fields are deleted.
- Moderation shapes (`user_deleted` etc.) unchanged: `{ event, sub, actor }`.
- `CognitoDeleteUserResponse`: drop the `recommendationsDeleted` field (its producer goes
  away).
- `ActivityItem`: no schema change — user events reuse the existing `cognitoSub` field.
  Doc comments updated (the "user_registered/user_deleted carry phone/name/email" note is
  obsolete).

### 2. Producers

- **post-confirmation** (`confirm.ts`): the `user_registered` audit invoke sends only
  `{ event, sub }`; it stops reading profile attributes for audit purposes.
- **audit-writer** (`payload.ts`): the `user_registered` case shapes `{ type, sub }`.
  Moderation cases unchanged.

### 3. Feed mapping (`services/admin-ledger-view/src/activity.ts`)

`auditEntryToItem` lifts `p.sub` into `cognitoSub` generically (any payload carrying a `sub`
string), alongside the existing `p.cognitoSub` lift for `wallet_entry`. One lift covers all
current and future user-scoped events, including the scrubbed historical rows.

### 4. Activity UI (`apps/admin/src/features/ActivityView.tsx`)

The member-resolution block (resolve `cognitoSub` → name/phone via `adminApi.getUser`, cached
per sub; render `Link` to `/users/{sub}`; shortened uuid on resolution failure) currently
gates on `type === "wallet_entry"`. The gate becomes "item has `cognitoSub`". The
`config_changed` actor rendering and the `user_deleted` "deleted by {admin}" subtitle stay
as-is. Old scrubbed `user_registered` rows and new ones render identically.

### 5. Deletion keeps data (`services/admin-console/src/handler.ts`)

`POST /admin/users/cognito-delete`:

- Remove the `recommendations.deleteByOwner(sub)` call and the `recommendationsDeleted`
  response field.
- Keep: sub resolution, Cognito removal, exact counter decrement (total / disabled),
  audit-or-fail `user_deleted` event, idempotent `existed: false` retry semantics.
- **Shrink admin-console's recommendation grant to read-only** (`infra/lib/admin-stack.ts`
  ~175): the erasure was the only caller of the narrowed write grant (`DeleteItem` +
  counter-conditioned `UpdateItem`), so that block is removed and `grantReadData` remains.
  Admin cannot delete recommendations at all in this slice; the future explicit-erase action
  re-introduces a scoped grant when it lands.
- **Remove `deleteByOwner`** from `packages/dynamo/src/recommendation.ts` (+ its tests) —
  admin-console was its sole caller; it would otherwise be dead code behind a revoked grant.
- **ADR-0006 decision 8** is edited in place (pre-production exception): deletion = Cognito
  account only; recommendation erasure moves to *Alternatives considered / future explicit
  erase action*. The admin SPA's delete confirmation copy is updated to match ("account is
  removed; links and wallet history are retained").

### 6. Deleted-user page (`apps/admin/src/features/UserDetailView.tsx`)

On `userStatus === "missing"` the page renders instead of bailing:

- Header: shortened sub (`{sub.slice(0, 8)}…`, full sub in a `title`/copyable element) + a
  "Deleted user" badge.
- Identity card: omitted (no PII exists anywhere to show — that is the point).
- Moderation actions (disable/enable/sign-out/delete): hidden.
- **Wallet section**: loads as for a live user — `GET /admin/users/{sub}/wallet`
  (admin-ledger-view, Aurora rows keyed by sub survive deletion).
- **Recommendations section**: loads as for a live user —
  `GET /admin/users/{sub}/recommendations` (DynamoDB `byOwner` GSI, independent of Cognito).
- New i18n strings (English + Hebrew) via `AdminI18nProvider`: "Deleted user" badge label and
  an explanatory line ("This account was deleted; retained activity is shown below.").
- `userStatus === "failed"` (non-404 error) keeps today's error rendering.

### 7. Scrub migration (`packages/db/migrations/0011_scrub_audit_pii.sql`)

One plain-SQL migration, one DO block:

1. `PERFORM pg_advisory_xact_lock(hashtext('audit_log'))` — same lock `audit_append` takes,
   so concurrent appends serialize against the rewrite.
2. Iterate all rows in `id` order. Track `v_prev` (previous row's recomputed `entry_hash`,
   starting `NULL`).
3. For rows with `payload->>'type' = 'user_registered'`: replace payload with
   `jsonb_build_object('type', 'user_registered', 'sub', payload->>'sub')`.
4. For EVERY row (the chain cascades): recompute with 0005's exact formula —
   `entry_hash = encode(digest(coalesce(v_prev, '') || '|' || payload::text || '|' ||
   extract(epoch from created_at)::text, 'sha256'), 'hex')`, and set
   `prev_hash = v_prev`. `created_at` is never modified.
5. UPDATE each row's `payload`, `prev_hash`, `entry_hash`. `wanthat_migrator` owns
   `audit_log`, so the UPDATE works despite revoked table grants.

The chain remains verifiable end-to-end afterward. Idempotent by construction: a re-run
rewrites the same payloads to the same values and recomputes the same hashes.

### 8. Tests

- `services/audit-writer/src/payload.test.ts` — `user_registered` shapes `{type, sub}` only.
- `services/post-confirmation/src/confirm.test.ts` — audit invoke payload is `{event, sub}`.
- `services/admin-ledger-view/src/activity.test.ts` — `p.sub` lifts to `cognitoSub` for
  user events; wallet_entry lift unchanged; scrubbed-row shape renders.
- `services/admin-console` handler tests — cognito-delete no longer calls `deleteByOwner`;
  response has no `recommendationsDeleted`; counters + audit unchanged.
- `apps/admin` — ActivityView links user events by `cognitoSub`; UserDetailView missing-user
  state shows badge + wallet + recommendations, hides identity + moderation.
- `packages/db` (Testcontainers) — migration test: seed a chain with PII rows via
  `audit_append`, run 0011, assert payloads scrubbed, chain verifies end-to-end with the 0005
  formula, and a post-migration `audit_append` continues the chain.

## Out of scope

- An explicit "delete + erase data" admin action (future privacy-request flow — will need its
  own scoped recommendation write grant).
- Any change to `wallet_entry` audit payloads or money paths.
- The DDoS incident playbook (separate, paused thread).

## Delivery

One PR — a single deployable use-case slice ("audit is PII-free; deleted users stay
inspectable"): contracts + three services + SPA + one migration + one CDK grant narrowing
(admin-console → recommendation table becomes read-only; `cdk diff` should show only that
IAM policy shrink). The migration runs automatically in-deploy via db-migrator.
