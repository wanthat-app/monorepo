# Audit PII Removal + Deleted-User Admin Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit log carries no member PII (uuid only, linked in the admin UI), account deletion keeps the member's data, and the admin users page renders deleted users with their surviving wallet + recommendations.

**Architecture:** Shrink the `user_registered` audit contract to `{event, sub}`; lift `sub` → `cognitoSub` generically in the feed mapper; reuse ActivityView's wallet_entry resolve-and-link pattern for all user events; drop the recommendation erasure from cognito-delete (and the CDK write grant + `deleteByOwner` with it); scrub historical rows with a chain-recomputing migration.

**Tech Stack:** Zod contracts, Hono Lambdas, Kysely plain-SQL migrations (Testcontainers), React SPA, CDK.

**Spec:** `docs/superpowers/specs/2026-07-18-audit-pii-free-deleted-user-flow-design.md`

## Global Constraints

- Biome must pass: run `pnpm lint` before the PR (CI runs it; build/test do not catch format drift).
- Migration 0011 must reuse 0005's exact digest formula: `encode(digest(coalesce(prev,'') || '|' || payload::text || '|' || extract(epoch from created_at)::text, 'sha256'), 'hex')`.
- Admin `actor` emails stay in audit payloads (employee data — allowed).
- No infra change beyond removing admin-console's recommendation write grant; `pnpm synth` must succeed and `cdk diff` must show only that IAM shrink.
- One PR off a feature branch; merge to `main` deploys dev; prod promotes explicitly after dev verification.

---

### Task 0: Branch setup

The two spec commits (`1dd14f4`, `3315923`) are LOCAL on `main` (unpushed). Move them onto the feature branch and restore `main` to origin.

- [ ] **Step 1:** `git checkout -b feat/audit-pii-free-deleted-user-flow` (keeps the spec commits)
- [ ] **Step 2:** `git branch -f main origin/main` (reset local main pointer; we are on the feature branch)
- [ ] **Step 3:** `git log --oneline origin/main..HEAD` — expect exactly the two spec commits.

### Task 1: Contracts — PII-free `UserRegisteredAudit`, lean `CognitoDeleteUserResponse`

**Files:**
- Modify: `packages/contracts/src/audit/write.ts`
- Modify: `packages/contracts/src/identity/admin-users.ts` (cognito-delete jsdoc + response)
- Modify: `packages/contracts/src/activity/admin.ts` (comment only)

**Interfaces (Produces):** `UserRegisteredAudit = { event: "user_registered", sub: Uuid }`; `CognitoDeleteUserResponse = { ok: true, existed: boolean }`.

- [ ] **Step 1:** In `audit/write.ts` replace the `UserRegisteredAudit` schema and drop the now-unused `PhoneE164` import:

```ts
import { z } from "zod";
import { Uuid } from "../common";
```

```ts
/**
 * A confirmed member signup (Cognito is the user store; `sub` is canonical, ADR-0020).
 * PII-FREE by design: the audit log is append-only and unrewritable, so member PII (phone,
 * name, email) must never enter it — the feed resolves the sub to a live profile via the
 * users API instead. (Admin actor emails are employee data and stay.)
 */
export const UserRegisteredAudit = z.object({
  event: z.literal("user_registered"),
  sub: Uuid,
});
```

Also update the file header comment: replace the sentence "`user_registered` keeps the `phone`/`firstName`/`lastName`/`email` keys the feed lifts." with "`user_registered` carries only the member's `sub` (PII-free; the feed resolves it via the users API)."

- [ ] **Step 2:** In `identity/admin-users.ts`: remove `recommendationsDeleted` from `CognitoDeleteUserResponse`; rewrite the cognito-delete jsdoc:

```ts
/**
 * POST /admin/users/cognito-delete (admin-credentials, non-VPC) — remove the Cognito account
 * ONLY (ADR-0006 decision 8, amended 2026-07-18): the member's recommendations and wallet
 * history are retained (non-PII, keyed by sub) so the admin console can still inspect a
 * deleted user. The sub is resolved via `AdminGetUser` before `AdminDeleteUser`.
 */
export const CognitoDeleteUserBody = z.object({
  phone: PhoneE164,
});
export type CognitoDeleteUserBody = z.infer<typeof CognitoDeleteUserBody>;

export const CognitoDeleteUserResponse = z.object({
  ok: z.literal(true),
  // false when the Cognito account was already gone (idempotent retry) — not an error.
  existed: z.boolean(),
});
export type CognitoDeleteUserResponse = z.infer<typeof CognitoDeleteUserResponse>;
```

- [ ] **Step 3:** In `activity/admin.ts` update the `ActivityItem` doc comment: replace "user_registered/user_deleted carry phone/name/email (actor on deletions)" with "user_registered/user_deleted carry the member's sub in `cognitoSub` (actor on deletions); pre-scrub historical rows may still carry phone/name/email".

- [ ] **Step 4:** `pnpm --filter @wanthat/contracts test` and `pnpm --filter @wanthat/contracts build` — expect pass (downstream breakage surfaces in later tasks).

- [ ] **Step 5:** Commit: `git commit -am "feat(contracts): user_registered audit is PII-free; cognito-delete keeps data"`

### Task 2: audit-writer shapes `{type, sub}`

**Files:**
- Modify: `services/audit-writer/src/payload.ts`
- Test: `services/audit-writer/src/payload.test.ts`

- [ ] **Step 1:** Rewrite the two `user_registered` tests in `payload.test.ts` (replace "keeps user_registered feed-compatible..." and "omits the optional profile fields..." tests) with:

```ts
it("shapes user_registered as {type, sub} — NO member PII ever enters the chain", () => {
  const request = AuditWriteRequest.parse({ event: "user_registered", sub: SUB });
  expect(auditPayload(request)).toEqual({ type: "user_registered", sub: SUB });
});

it("rejects a user_registered request smuggling profile fields", () => {
  const request = AuditWriteRequest.parse({
    event: "user_registered",
    sub: SUB,
    phone: "+972501234567",
    email: "dana@example.com",
  });
  expect(auditPayload(request)).toEqual({ type: "user_registered", sub: SUB });
});
```

(Zod strips unknown keys by default, so the parse in the second test drops the smuggled fields — the assertion documents that.)

- [ ] **Step 2:** Run: `pnpm --filter @wanthat/audit-writer test` — expect FAIL (payload still emits phone).
- [ ] **Step 3:** In `payload.ts` replace the `user_registered` case and update the header comment ("the feed lifts `type` and `sub`; member PII never enters the chain"):

```ts
    case "user_registered":
      return { type: "user_registered", sub: request.sub };
```

- [ ] **Step 4:** Run: `pnpm --filter @wanthat/audit-writer test` — expect PASS.
- [ ] **Step 5:** Commit: `git commit -am "feat(audit-writer): user_registered payload is {type, sub} only"`

### Task 3: post-confirmation sends only the sub

**Files:**
- Modify: `services/post-confirmation/src/confirm.ts:95-113`
- Test: `services/post-confirmation/src/confirm.test.ts:111-160`

- [ ] **Step 1:** Update the signup-audit tests: the first test now expects `{event, sub}`; DELETE the "omits absent/empty profile attributes" test; the "logs (not throws) on an event without phone_number" test moves out of the audit describe (audit no longer needs phone — see Step 3) and is replaced by:

```ts
it("invokes audit-writer with only the sub — no profile fields (PII-free audit)", async () => {
  await handleConfirmation(deps, event(ATTRS));
  expect(deps.audit.write).toHaveBeenCalledWith({ event: "user_registered", sub: "sub-1234" });
  expect(deps.log.info).toHaveBeenCalledWith("signup_audit_invoked", { sub: "sub-1234" });
});

it("still writes the audit row when phone_number is absent (audit needs only the sub)", async () => {
  await handleConfirmation(deps, event({ ...ATTRS, phone_number: undefined }));
  expect(deps.audit.write).toHaveBeenCalledWith({ event: "user_registered", sub: "sub-1234" });
});

it("logs (not throws) on an event without sub", async () => {
  await handleConfirmation(deps, event({ ...ATTRS, sub: undefined }));
  expect(deps.audit.write).not.toHaveBeenCalled();
  expect(deps.log.error).toHaveBeenCalledWith(
    "signup_audit_invoke_failed",
    expect.objectContaining({ error: "event carries no sub" }),
  );
});
```

(Keep the existing "swallows an audit invoke failure" and "still writes the audit row when the welcome invoke failed" tests unchanged.)

- [ ] **Step 2:** Run: `pnpm --filter @wanthat/post-confirmation test` — expect FAIL.
- [ ] **Step 3:** In `confirm.ts` replace the audit block (lines 95-113) with:

```ts
  // The signup audit row (user_registered): sub only — the audit log is append-only, so member
  // PII (phone/name/email) must never enter it; the admin feed resolves the sub live instead.
  try {
    if (!sub) throw new Error("event carries no sub");
    await deps.audit.write({ event: "user_registered", sub });
    deps.log.info("signup_audit_invoked", { sub });
  } catch (err) {
    deps.log.error("signup_audit_invoke_failed", {
      sub,
      error: err instanceof Error ? err.message : String(err),
    });
  }
```

- [ ] **Step 4:** Run: `pnpm --filter @wanthat/post-confirmation test` — expect PASS.
- [ ] **Step 5:** Commit: `git commit -am "feat(post-confirmation): signup audit carries only the sub"`

### Task 4: Feed mapper lifts `sub` → `cognitoSub`

**Files:**
- Modify: `services/admin-ledger-view/src/activity.ts`
- Test: `services/admin-ledger-view/src/activity.test.ts`

**Interfaces (Produces):** any audit payload with a string `sub` yields `ActivityItem.cognitoSub` (existing `p.cognitoSub` lift for wallet_entry unchanged; `p.cognitoSub` wins if both present).

- [ ] **Step 1:** Update `activity.test.ts`: rewrite the "maps a user_registered payload" test for the scrubbed shape and add sub-lift tests for moderation rows:

```ts
it("maps a scrubbed user_registered payload: sub lifts to cognitoSub", () => {
  const item = auditEntryToItem({
    id: "7",
    createdAt: AT,
    payload: { type: "user_registered", sub: "11111111-1111-1111-1111-111111111111" },
  });
  expect(item).toEqual({
    id: "audit_7",
    type: "user_registered",
    at: AT.toISOString(),
    cognitoSub: "11111111-1111-1111-1111-111111111111",
  });
});

it("still lifts legacy pre-scrub PII keys (historical rows must render)", () => {
  const item = auditEntryToItem({
    id: "8",
    createdAt: AT,
    payload: {
      type: "user_registered",
      sub: "11111111-1111-1111-1111-111111111111",
      phone: "+972501234567",
      firstName: "Maya",
      lastName: "Levi",
    },
  });
  expect(item.cognitoSub).toBe("11111111-1111-1111-1111-111111111111");
  expect(item.phone).toBe("+972501234567");
  expect(item.name).toBe("Maya Levi");
});
```

Also update the existing "maps a user_deleted payload with actor" test to seed `sub: "11111111-1111-1111-1111-111111111111"` (instead of `customerId`) and assert `cognitoSub` is lifted alongside `actor`.

- [ ] **Step 2:** Run: `pnpm --filter @wanthat/admin-ledger-view test` — expect FAIL (no cognitoSub lifted).
- [ ] **Step 3:** In `activity.ts` `auditEntryToItem`, change the cognitoSub lift line to fall back to `p.sub` and update its comment:

```ts
    // The member the event is about: wallet_entry payloads name it `cognitoSub`; user events
    // (user_registered / moderation) carry `sub`. Either way the SPA resolves + links it.
    ...(str(p.cognitoSub) ?? str(p.sub)
      ? { cognitoSub: str(p.cognitoSub) ?? str(p.sub) }
      : {}),
```

- [ ] **Step 4:** Run: `pnpm --filter @wanthat/admin-ledger-view test` — expect PASS.
- [ ] **Step 5:** Commit: `git commit -am "feat(admin-ledger-view): lift audit sub into cognitoSub for user events"`

### Task 5: cognito-delete keeps recommendations; `deleteByOwner` dies

**Files:**
- Modify: `services/admin-console/src/handler.ts:305-337` (cognito-delete route)
- Modify: `services/admin-console/src/context.ts:27` (comment only)
- Modify: `packages/dynamo/src/recommendation.ts` (remove `deleteByOwner`)
- Test: `services/admin-console/src/handler.test.ts`, `packages/dynamo/src/recommendation.test.ts`

- [ ] **Step 1:** In `handler.test.ts`: remove `deleteByOwner` from the `ctx.recommendations` mock (keep `count`), remove all `deleteByOwner` mock setups/resets/assertions, and change cognito-delete expectations: response is `{ ok: true, existed: ... }` with NO `recommendationsDeleted`; add one explicit assertion on the happy path:

```ts
expect(res.body).toEqual({ ok: true, existed: true });
```

- [ ] **Step 2:** Run: `pnpm --filter @wanthat/admin-console test` — expect FAIL (route still returns recommendationsDeleted).
- [ ] **Step 3:** In `handler.ts` rewrite the cognito-delete route (comment + body):

```ts
// POST /admin/users/cognito-delete — remove a customer's Cognito account ONLY (ADR-0006
// decision 8, amended 2026-07-18): recommendations and wallet history are retained (non-PII,
// keyed by sub) so the deleted-user admin page stays inspectable. Idempotent: an already-gone
// account is `existed: false`, not an error, so the SPA can retry safely — and the retry
// writes no second audit event or counter decrement.
app.post("/admin/users/cognito-delete", async (c) => {
  const body = CognitoDeleteUserBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const { existed, sub, wasDisabled } = await getContext().cognitoUsers.remove(body.data.phone);
  // Exact customer counter: one erased account = total - 1 (and disabled - 1 when it was
  // suspended). Only when the account existed — the idempotent retry must not double-decrement.
  // NOTE: SELF-service account deletion (Cognito DeleteUser) does not exist in the SPA yet
  // (verified 2026-07-09 — no caller anywhere); when that flow arrives it MUST decrement too.
  if (existed) {
    await counterWrite("decrementTotal", body.data.phone, () =>
      getContext().customerCounter.decrementTotal(wasDisabled),
    );
    if (!(await auditModeration(c, "user_deleted", sub))) {
      return c.json({ error: "audit_failed" }, 500);
    }
  }
  return c.json(CognitoDeleteUserResponse.parse({ ok: true, existed }));
});
```

Update `context.ts:27` comment to: `/** Recommendation reads for stats/views; deletion keeps recommendations (ADR-0006 d8 amended). */`

- [ ] **Step 4:** In `packages/dynamo/src/recommendation.ts` delete the `deleteByOwner` method (and now-unused imports if any); in `recommendation.test.ts` delete its describe/tests.
- [ ] **Step 5:** Run: `pnpm --filter @wanthat/admin-console test && pnpm --filter @wanthat/dynamo test` — expect PASS.
- [ ] **Step 6:** Commit: `git commit -am "feat(admin-console): deletion keeps recommendations; drop deleteByOwner"`

### Task 6: CDK — admin-console recommendation grant becomes read-only

**Files:**
- Modify: `infra/lib/admin-stack.ts:175-197`

- [ ] **Step 1:** Replace the narrowed-write-grant block (comment + `grantReadData` + BOTH `addToRolePolicy` statements) with:

```ts
    // Recommendation: READ-ONLY (2026-07-18, spec audit-pii-free-deleted-user-flow). The
    // erasure path died with it — deletion keeps the member's recommendations, so the console
    // holds no write of any kind here: it can never delete, rewrite, or forge one. The future
    // explicit-erase action re-introduces a scoped write grant when it lands.
    props.recommendationTable.grantReadData(consoleFn);
```

Remove the `iam` import ONLY if this was its last use in the file (check other `addToRolePolicy`/`PolicyStatement` uses first — the retailer-secret block above uses it, so it almost certainly stays).

- [ ] **Step 2:** Run: `pnpm synth` — expect success.
- [ ] **Step 3:** Commit: `git commit -am "feat(infra): admin-console recommendation grant shrinks to read-only"`

### Task 7: Migration 0011 — scrub + re-chain

**Files:**
- Create: `packages/db/migrations/0011_scrub_audit_pii.sql`
- Test: `packages/db/src/migrations.test.ts`

- [ ] **Step 1:** Add to `migrations.test.ts`: bump `MIGRATION_COUNT` to 11, and append this test (inside the existing describe, after the audit-chain tests):

```ts
it("0011 scrubs user_registered PII and re-chains verifiably", async () => {
  // Seed a mixed chain THROUGH audit_append (as production wrote it), PII included.
  await asRole("audit_writer", async (trx) => {
    await sql`SELECT audit_append(${JSON.stringify({
      type: "user_registered",
      sub: "22222222-2222-2222-2222-222222222222",
      phone: "+972501234567",
      firstName: "Maya",
      lastName: "Levi",
      email: "maya@example.com",
    })}::jsonb, now())`.execute(trx);
    await sql`SELECT audit_append(${JSON.stringify({
      type: "user_deleted",
      sub: "22222222-2222-2222-2222-222222222222",
      actor: "admin@wanthat.app",
    })}::jsonb, now())`.execute(trx);
  });

  // Re-run 0011's SQL directly (it is idempotent by construction) against the seeded rows.
  const migrationSql = await readFile(join(MIGRATIONS_DIR, "0011_scrub_audit_pii.sql"), "utf8");
  await sql.raw(migrationSql).execute(db);

  // 1) No PII key survives anywhere in the log.
  const { rows: pii } = await sql<{ n: string }>`
    SELECT count(*) AS n FROM audit_log
    WHERE payload ?| array['phone', 'firstName', 'lastName', 'email']
      AND payload->>'type' = 'user_registered'
  `.execute(db);
  expect(Number(pii[0]?.n)).toBe(0);

  // 2) The scrubbed row kept type + sub.
  const { rows: scrubbed } = await sql<{ payload: { type: string; sub: string } }>`
    SELECT payload FROM audit_log WHERE payload->>'sub' = '22222222-2222-2222-2222-222222222222'
      AND payload->>'type' = 'user_registered'
  `.execute(db);
  expect(scrubbed[0]?.payload).toEqual({
    type: "user_registered",
    sub: "22222222-2222-2222-2222-222222222222",
  });

  // 3) The whole chain verifies with 0005's formula (lag() replays the linkage).
  const { rows: broken } = await sql<{ n: string }>`
    SELECT count(*) AS n FROM (
      SELECT entry_hash, prev_hash, payload, created_at,
             lag(entry_hash) OVER (ORDER BY id) AS expected_prev
      FROM audit_log
    ) c
    WHERE c.prev_hash IS DISTINCT FROM c.expected_prev
       OR c.entry_hash <> encode(digest(
            coalesce(c.expected_prev, '') || '|' || c.payload::text || '|' ||
            extract(epoch from c.created_at)::text, 'sha256'), 'hex')
  `.execute(db);
  expect(Number(broken[0]?.n)).toBe(0);

  // 4) audit_append continues the chain after the rewrite.
  await asRole("audit_writer", async (trx) => {
    await sql`SELECT audit_append(${JSON.stringify({ type: "user_registered", sub: "33333333-3333-3333-3333-333333333333" })}::jsonb, now())`.execute(trx);
  });
});
```

Add the imports: `import { readFile } from "node:fs/promises";` and `import { join } from "node:path";`.

- [ ] **Step 2:** Run: `pnpm --filter @wanthat/db test -- migrations` — expect FAIL (file missing / count 10).
- [ ] **Step 3:** Create `packages/db/migrations/0011_scrub_audit_pii.sql`:

```sql
-- 0011 scrub_audit_pii — remove member PII from historical user_registered audit payloads
-- (spec docs/superpowers/specs/2026-07-18-audit-pii-free-deleted-user-flow-design.md).
-- The audit log is hash-chained (0005: entry_hash = sha256(prev|payload|epoch)), so editing
-- any payload cascades: EVERY row's hash is recomputed in id order with 0005's exact formula.
-- Idempotent: a re-run rewrites identical payloads to identical hashes. The log is tiny
-- (pre-release), so a full re-chain is milliseconds. Runs as wanthat_migrator, which OWNS
-- audit_log — the UPDATE works despite the revoked table grants (append-only still holds for
-- every service role).
DO $$
DECLARE
  v_prev text := NULL;
  v_payload jsonb;
  v_hash text;
  r record;
BEGIN
  -- Same lock audit_append takes: no append may interleave with the rewrite.
  PERFORM pg_advisory_xact_lock(hashtext('audit_log'));
  FOR r IN SELECT id, payload, created_at FROM audit_log ORDER BY id LOOP
    v_payload := CASE
      WHEN r.payload->>'type' = 'user_registered'
        THEN jsonb_build_object('type', 'user_registered', 'sub', r.payload->>'sub')
      ELSE r.payload
    END;
    v_hash := encode(
      digest(
        coalesce(v_prev, '') || '|' || v_payload::text || '|' || extract(epoch from r.created_at)::text,
        'sha256'
      ),
      'hex'
    );
    UPDATE audit_log SET payload = v_payload, prev_hash = v_prev, entry_hash = v_hash
    WHERE id = r.id;
    v_prev := v_hash;
  END LOOP;
END $$;
```

- [ ] **Step 4:** Run: `pnpm --filter @wanthat/db test -- migrations` — expect PASS (Docker required).
- [ ] **Step 5:** Commit: `git commit -am "feat(db): migration 0011 scrubs audit PII and re-chains"`

### Task 8: ActivityView — resolve + link every user event

**Files:**
- Modify: `apps/admin/src/features/ActivityView.tsx:29-51` (resolveMembers), `:231-285` (UserCell)

- [ ] **Step 1:** In `resolveMembers` drop the type gate (any item carrying `cognitoSub` resolves):

```ts
    const subs = items.flatMap((i) => (i.cognitoSub ? [i.cognitoSub] : []));
```

Update the comment above `members` state: "audit payloads carry only the member's sub (wallet_entry, user_registered, moderation events — admin-ledger-view cannot reach Cognito from the endpoint-free VPC, ADR-0004) — the SPA resolves name/phone through the non-VPC users API, once per sub for the component's lifetime; a miss (e.g. a deleted user) renders the shortened sub."

- [ ] **Step 2:** In `UserCell`, change the linked-member branch gate from `item.type === "wallet_entry" && item.cognitoSub` to `item.cognitoSub` (the `config_changed` branch above it stays first; the legacy name/phone fallback below stays for pre-scrub rows), and update the function's doc comment: "config_changed shows the ACTING ADMIN; anything carrying `cognitoSub` (wallet_entry, user_registered, moderation events) shows the member resolved from the sub, linked to their detail page — a deleted/unresolved member renders the shortened sub, still linked; pre-scrub historical rows fall back to the payload's own name/phone."
- [ ] **Step 3:** Run: `pnpm --filter @wanthat/admin-app test && pnpm --filter @wanthat/admin-app build` (confirm the filter name from `apps/admin/package.json` first; adjust if it differs) — expect PASS.
- [ ] **Step 4:** Commit: `git commit -am "feat(admin-spa): activity feed links every user event by sub"`

### Task 9: UserDetailView deleted-user state + UsersView copy + i18n

**Files:**
- Modify: `apps/admin/src/features/UserDetailView.tsx`
- Modify: `apps/admin/src/features/UsersView.tsx:99-113`
- Modify: `apps/admin/src/i18n.ts` (en `userPage` block ~line 64, he block ~line 366; `usersPage.deletedWithRecs` en ~42 / he ~345)

- [ ] **Step 1:** In `UserDetailView.tsx` delete the early `if (userStatus === "missing")` return (lines 89-91). In the Identity card, render a deleted-user variant when missing — replace the card's ternary chain so `missing` shows:

```tsx
        ) : userStatus === "missing" ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <h2 className="font-mono text-[17px] font-bold text-ink" dir="ltr" title={sub}>
              {sub.slice(0, 8)}…
            </h2>
            <StatusBadge status="rejected">{t("admin.userPage.deletedBadge")}</StatusBadge>
            <span className="text-[13px] text-muted">{t("admin.userPage.deletedNote")}</span>
          </div>
        ) : userStatus === "failed" ? (
```

(Order: loading → missing → failed → user. Wallet + Recommendations sections below need NO change — their calls already run unconditionally and their data survives deletion.)

- [ ] **Step 2:** In `UsersView.tsx` `onDelete`, the response no longer carries `recommendationsDeleted` — replace the toast selection with plain `setNotice(t("admin.usersPage.deleted"));` and update the comment above `onDelete`: "Cognito-account delete ONLY (ADR-0006 d8 amended): the member's recommendations and wallet history are retained and stay inspectable on the user page."
- [ ] **Step 3:** In `i18n.ts`: delete BOTH `deletedWithRecs` keys; add to the en `userPage` block:

```ts
      deletedBadge: "Deleted user",
      deletedNote: "This account was deleted; retained activity is shown below.",
```

and to the he `userPage` block:

```ts
      deletedBadge: "משתמש שנמחק",
      deletedNote: "החשבון נמחק; הפעילות שנשמרה מוצגת למטה.",
```

(Keep `notFound` — the admin-i18n key-parity test requires both locales for every key; run it in Step 4.)

- [ ] **Step 4:** Run: `pnpm --filter @wanthat/admin-app test && pnpm --filter @wanthat/admin-app build` — expect PASS (i18n parity test covers the new keys).
- [ ] **Step 5:** Commit: `git commit -am "feat(admin-spa): deleted users render with retained wallet + recommendations"`

### Task 10: ADR-0006 decision 8 amendment + docs

**Files:**
- Modify: `adrs/0006-cognito-native-auth-and-pii.md` (decision 8, ~line 88)
- Modify: `docs/AWS_Architecture.md` (§3.4 admin-console bullet; diagram edge `admincon -- "erasure delete + counter - no PutItem grant" --> t_rec`)

- [ ] **Step 1:** In ADR-0006 decision 8, replace the final sentence ("The admin surface ... gains the disable / enable / global-sign-out grants beside its existing delete grant, and deleting a user also deletes their DynamoDB recommendations (by `byOwner` GSI) with a counter decrement.") with:

```markdown
   The admin surface (today's `admin-console`) holds the disable / enable / global-sign-out
   grants; its recommendation-table access is READ-ONLY. *Amended 2026-07-18 (pre-production
   exception): deletion removes the Cognito account only — the member's recommendations and
   wallet rows are retained (non-PII, keyed by the now-orphaned sub) so the admin console can
   inspect deleted users; audit payloads carry only the sub (no member PII — the activity
   feed resolves it live). The original erase-recommendations-on-delete behavior moves to a
   future explicit "delete + erase data" action, which will bring its own scoped write grant.*
```

- [ ] **Step 2:** In `docs/AWS_Architecture.md`: (a) in the §3.4 admin-console bullet, replace "Its Recommendation grant is narrowed: read + `DeleteItem` + `UpdateItem` conditioned to the `#counter` leading key — **no PutItem**." with "Its Recommendation grant is **read-only** (deletion keeps the member's recommendations — ADR-0006 d8 amended 2026-07-18)."; (b) in the Mermaid diagram change the edge `admincon -- "erasure delete + counter -<br>no PutItem grant" --> t_rec` to a plain read edge `t_rec --> admincon` (delete the old edge; a `t_rec --> admincon` read edge already exists near the bottom — if so, just delete the erasure edge); (c) §3.3 admin routes and §4 flows mention nothing about erasure — no change. Keep Mermaid ASCII-only, no semicolons.
- [ ] **Step 3:** Commit: `git commit -am "docs: ADR-0006 d8 amendment - deletion keeps data; grant read-only"`

### Task 11: Full verification + PR

- [ ] **Step 1:** `pnpm build && pnpm typecheck && pnpm test && pnpm lint` — all green (fix anything that surfaces; `packages/db` tests need Docker running).
- [ ] **Step 2:** `pnpm synth` then `pnpm diff` (needs AWS creds; if expired, ask Dennis to re-login). Expected diff: ONLY the admin-console IAM policy losing the recommendation `DeleteItem`/`UpdateItem` statements — nothing else.
- [ ] **Step 3:** Push branch, open PR (ready, not draft) titled `feat: PII-free audit log + deleted-user admin flow`, body summarizing the spec decisions + the cdk-diff result. Watch CI + Check Deploy (a red check-deploy is blocking).
- [ ] **Step 4:** After merge to `main`: dev auto-deploys (migration 0011 runs via db-migrator). Verify in dev: `GET /admin/activity` rows carry `cognitoSub` and no PII for user events; delete a test user and confirm the users page renders the deleted state with recommendations.
- [ ] **Step 5:** Promote to prod (explicit promotion per repo convention — confirm the exact mechanism from `.github/workflows/` before running). Verify the same in prod.

## Self-review notes

- Spec coverage: contracts (T1), producers (T2, T3), feed lift (T4), delete keeps data + dead code (T5), grant shrink (T6), migration + chain test (T7), ActivityView (T8), deleted-user page + copy + i18n (T9), ADR/docs (T10), delivery (T11). Complete.
- The legacy `DELETE /admin/users/:id` 410 route and `DeleteUserResponse` schema are OUT of scope (pre-existing cleanup note, unrelated to this slice).
- Type consistency: `cognitoSub` is the single carrier field end-to-end (mapper T4 → SPA T8); `CognitoDeleteUserResponse` without `recommendationsDeleted` is consumed in T5 (server) and T9 (SPA).
