# Admin Activity Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin "Activity" page: one paged feed of audit-log events (registrations + deletions, hash-chained in Aurora) plus dev-only OTP codes from the DynamoDB dev sink.

**Architecture:** `audit_log` becomes the single Aurora feed source — migration 0005 adds the `audit_append()` hash-chain writer, a two-arg `admin_delete_customer`, and a registration backfill. admin-api exposes `GET /admin/activity` (offset-paged) and merges `dev_otp_sink` items into page 1 when the sink env var exists (non-prod only). The SPA adds an ActivityView mirroring UsersView.

**Tech Stack:** PostgreSQL (Aurora, pgcrypto), Kysely, Zod contracts, Hono Lambda, React + Tailwind (existing DS tokens), AWS CDK v2, vitest.

**Spec:** `docs/superpowers/specs/2026-07-08-admin-activity-page-design.md` (approved).

## Global Constraints

- Monorepo commands from repo root: `pnpm typecheck`, `pnpm test`, `pnpm synth`. Single workspace: `pnpm --filter <pkg> test`.
- Infra description fields ASCII-only (non-ASCII breaks deploys).
- Never suppress warnings/deprecations; fix at source.
- No new workspace packages (so the infra-devDependencies deploy trap does not fire).
- ADRs are locked; nothing here changes an ADR decision.
- The dev OTP sink table does not exist in prod (fail-closed) — all sink code paths must be conditional on the `DEV_OTP_SINK_TABLE` env var.
- Payloads in `audit_log` are free-form jsonb; readers must tolerate unknown `type` values (render generically, never throw).

---

### Task 1: Migration 0005 — audit_append, two-arg admin_delete_customer, backfill

**Files:**
- Create: `packages/db/migrations/0005_audit_append.sql`

**Interfaces:**
- Consumes: schema from `0001_init.sql` (`audit_log`, `customer`, `wallet_entry`; pgcrypto already enabled; roles `app_rw`, `app_ro` exist), `0004_admin_delete_customer.sql` (one-arg function stays untouched).
- Produces (used by Task 4 via raw SQL):
  - `audit_append(p_payload jsonb, p_at timestamptz DEFAULT now()) RETURNS bigint` — EXECUTE granted to `app_rw`.
  - `admin_delete_customer(p_customer_id uuid, p_actor text) RETURNS TABLE (outcome text, phone text)` — EXECUTE granted to `app_ro`. Outcomes: `'deleted' | 'not_found' | 'has_wallet_history'`, same as the 0004 one-arg version.
  - Audit payload shapes (writers set exactly these keys):
    - `{"type":"user_registered","customerId","phone","firstName","lastName","email","backfilled"?}`
    - `{"type":"user_deleted","customerId","phone","firstName","lastName","email","actor"}`

- [ ] **Step 1: Write the migration**

```sql
-- 0005 audit_append — first implementation of the hash-chained audit log (0001; ADR-0005 §14),
-- plus user deletion/registration becoming audit events and a registration backfill.
--
-- audit_append is THE append path: it serialises writers with an advisory lock (the chain must
-- never fork), reads the previous entry_hash, and chains
--   entry_hash = sha256(prev_hash | payload | epoch(created_at))
-- via pgcrypto (enabled in 0001). SECURITY DEFINER (owner: wanthat_migrator) so callers need no
-- table-level INSERT; app_rw (registration writer) gets EXECUTE. app_ro does NOT - admin
-- deletions go through admin_delete_customer below, which calls it in definer context.
-- poller_writer keeps its direct INSERT grant for now; it moves onto audit_append with the
-- poller slice.
CREATE OR REPLACE FUNCTION audit_append(p_payload jsonb, p_at timestamptz DEFAULT now())
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev text;
  v_hash text;
  v_id   bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_log'));
  SELECT entry_hash INTO v_prev FROM audit_log ORDER BY id DESC LIMIT 1;
  -- extract(epoch ...) canonicalizes the timestamp: a bare timestamptz::text formats via the
  -- session TimeZone GUC, so the same instant could hash differently across sessions and a
  -- future chain verifier would see false tampering. Epoch seconds are representation-stable.
  v_hash := encode(
    digest(
      coalesce(v_prev, '') || '|' || p_payload::text || '|' || extract(epoch from p_at)::text,
      'sha256'
    ),
    'hex'
  );
  INSERT INTO audit_log (prev_hash, entry_hash, payload, created_at)
  VALUES (v_prev, v_hash, p_payload, p_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION audit_append(jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_append(jsonb, timestamptz) TO app_rw;
-- audit_append inserts as its owner, so the owner (not the caller) needs the sequence.
-- wanthat_migrator owns the table + sequence already (0003); nothing further to grant.

-- Two-arg admin_delete_customer: same guard/outcome contract as 0004, plus the delete now
-- appends a user_deleted audit row (the deleted identity + acting admin) atomically. The 0004
-- one-arg overload is deliberately LEFT IN PLACE so the running admin-api keeps working during
-- the migrate-then-deploy window (DataStack migrates before AdminStack updates the Lambda);
-- a later cleanup migration drops it.
CREATE OR REPLACE FUNCTION admin_delete_customer(p_customer_id uuid, p_actor text)
RETURNS TABLE (outcome text, phone text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row customer%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM wallet_entry w WHERE w.customer_id = p_customer_id) THEN
    RETURN QUERY SELECT 'has_wallet_history'::text, NULL::text;
    RETURN;
  END IF;

  DELETE FROM customer c WHERE c.id = p_customer_id RETURNING c.* INTO v_row;
  IF v_row.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;

  PERFORM audit_append(jsonb_build_object(
    'type',       'user_deleted',
    'customerId', v_row.id,
    'phone',      v_row.phone_e164,
    'firstName',  v_row.first_name,
    'lastName',   v_row.last_name,
    'email',      v_row.email,
    'actor',      p_actor
  ));

  RETURN QUERY SELECT 'deleted'::text, v_row.phone_e164;
END;
$$;

REVOKE ALL ON FUNCTION admin_delete_customer(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_delete_customer(uuid, text) TO app_ro;

-- Backfill: one user_registered row per existing customer, at their true registration time,
-- in deterministic order (created_at, id) so a re-run within an environment seeds the same chain.
-- created_at carries feed ordering; chain integrity is by id order, so historical timestamps
-- do not break it. Runs once (the migrator tracks applied migrations).
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT id, phone_e164, first_name, last_name, email, created_at
    FROM customer ORDER BY created_at, id
  LOOP
    PERFORM audit_append(jsonb_build_object(
      'type',       'user_registered',
      'customerId', c.id,
      'phone',      c.phone_e164,
      'firstName',  c.first_name,
      'lastName',   c.last_name,
      'email',      c.email,
      'backfilled', true
    ), c.created_at);
  END LOOP;
END $$;
```

- [ ] **Step 2: Sanity checks (no DB harness exists — static verification)**

Run: `pnpm typecheck` (must stay green — migration is plain SQL, nothing compiles it)
Run: `ls packages/db/migrations/` — expected: `0001_… 0002_… 0003_… 0004_… 0005_audit_append.sql`
Self-check the SQL against 0004's style: SECURITY DEFINER + `SET search_path = public, pg_temp` + REVOKE/GRANT — all present above.

- [ ] **Step 3: Commit**

```bash
git add packages/db/migrations/0005_audit_append.sql
git commit -m "feat(db): 0005 audit_append hash chain, audited delete, registration backfill"
```

---

### Task 2: Contracts — activity domain

**Files:**
- Create: `packages/contracts/src/activity/admin.ts`
- Create: `packages/contracts/src/activity/index.ts`
- Modify: `packages/contracts/src/index.ts` (add one export line)

**Interfaces:**
- Consumes: `OtpChannel` from `../identity/auth` (already exported via `../identity`).
- Produces (used by Tasks 6 and 7): `ListActivityQuery`, `ActivityItem`, `ListActivityResponse` — exported from `@wanthat/contracts`.

- [ ] **Step 1: Write `packages/contracts/src/activity/admin.ts`**

```ts
import { z } from "zod";
import { OtpChannel } from "../identity/auth";

/**
 * Admin activity feed (GET /admin/activity) — one paged list, newest first, over the Aurora
 * audit_log (user_registered / user_deleted / future audited admin actions) plus, in dev only,
 * live OTP codes from the dev sink (merged into page 1 by admin-api; the sink table does not
 * exist in prod, so the otp_sent item type can never appear there).
 */

/** Query for GET /admin/activity — 1-based paging, no filters in v1. */
export const ListActivityQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListActivityQuery = z.infer<typeof ListActivityQuery>;

/**
 * One feed row. `type` is an open string: audit payloads are free-form jsonb, and unknown/future
 * types must still render (the SPA shows a generic badge with the raw type). Field presence by
 * type: user_registered/user_deleted carry phone/name/email (actor on deletions); otp_sent
 * carries phone/channel/code/expiresAt.
 */
export const ActivityItem = z.object({
  id: z.string(), // "audit_<id>" | "otp_<phone>"
  type: z.string(),
  at: z.string().datetime(),
  phone: z.string().optional(),
  name: z.string().optional(), // "First Last" when known
  email: z.string().optional(),
  actor: z.string().optional(), // user_deleted: the acting admin
  channel: OtpChannel.optional(), // otp_sent only
  code: z.string().optional(), // otp_sent only - the dev sink code
  expiresAt: z.string().datetime().optional(), // otp_sent only
});
export type ActivityItem = z.infer<typeof ActivityItem>;

export const ListActivityResponse = z.object({
  items: z.array(ActivityItem),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ListActivityResponse = z.infer<typeof ListActivityResponse>;
```

- [ ] **Step 2: Write `packages/contracts/src/activity/index.ts`**

```ts
export * from "./admin";
```

- [ ] **Step 3: Wire the root barrel**

The export list in `packages/contracts/src/index.ts` is alphabetical; `activity` sorts first, so insert the new line at the top of the list:

```ts
export * from "./activity";
export * from "./common";
export * from "./config";
```

(only the `./activity` line is new — the rest stay as they are).

- [ ] **Step 4: Verify**

Run: `pnpm --filter @wanthat/contracts test` — expected: PASS (existing tests unaffected)
Run: `pnpm --filter @wanthat/contracts exec tsc --noEmit` (or `pnpm typecheck` at root) — expected: clean

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/activity packages/contracts/src/index.ts
git commit -m "feat(contracts): admin activity feed schemas"
```

---

### Task 3: @wanthat/dynamo — DevOtpSinkRepo.scanAll()

**Files:**
- Modify: `packages/dynamo/src/dev-otp-sink.ts`
- Test: `packages/dynamo/src/dev-otp-sink.test.ts` (extend the existing file, follow its existing mocking style)

**Interfaces:**
- Consumes: existing `DevOtpSinkRepo` (`doc: DynamoDBDocumentClient`, `tableName`), `DevOtpSinkItem { phone, code, channel, triggerSource, createdAt, ttl }`.
- Produces (used by Task 6): `DevOtpSinkRepo.scanAll(): Promise<DevOtpSinkItem[]>`.

- [ ] **Step 1: Read the existing test file** (`packages/dynamo/src/dev-otp-sink.test.ts`) and mirror its mocking approach for the new test.

- [ ] **Step 2: Write the failing test** (add to the existing describe block; adapt mock setup to the file's existing style — e.g. if it uses `aws-sdk-client-mock`, register `ScanCommand`):

```ts
it("scanAll returns every parked item", async () => {
  // Arrange the mock so ScanCommand resolves { Items: [item] } (match the file's mock style).
  const items = await repo.scanAll();
  expect(items).toEqual([expect.objectContaining({ phone: "+972501234567" })]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @wanthat/dynamo test`
Expected: FAIL — `repo.scanAll is not a function`

- [ ] **Step 4: Implement `scanAll`**

In `packages/dynamo/src/dev-otp-sink.ts`, extend the import and the class:

```ts
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
```

```ts
  /**
   * Every parked item — the admin activity feed (dev only) lists current codes. The sink holds
   * at most one 5-minute-TTL item per phone, so a single unpaginated scan is plenty; TTL
   * deletion lags are filtered by the caller (Dynamo TTL is best-effort).
   */
  async scanAll(): Promise<DevOtpSinkItem[]> {
    const res = await this.doc.send(new ScanCommand({ TableName: this.tableName }));
    return (res.Items ?? []) as DevOtpSinkItem[];
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @wanthat/dynamo test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/dynamo/src/dev-otp-sink.ts packages/dynamo/src/dev-otp-sink.test.ts
git commit -m "feat(dynamo): dev OTP sink scanAll for the admin activity feed"
```

---

### Task 4: @wanthat/db — registration audit write, two-arg delete, listAuditLog

**Files:**
- Modify: `packages/db/src/customer.ts` (insertCustomer, adminDeleteCustomer)
- Create: `packages/db/src/activity.ts`
- Modify: `packages/db/src/index.ts` (barrel)

**Interfaces:**
- Consumes: SQL functions from Task 1 (`audit_append(jsonb, timestamptz)`, `admin_delete_customer(uuid, text)`), existing `Database` Kysely schema (`audit_log` has `id: Generated<string>`, `payload: ColumnType<unknown, string, never>`, `created_at: Generated<Date>`).
- Produces (used by Task 6):
  - `insertCustomer(db, input)` — same signature/behaviour, now also appends the `user_registered` audit row in the same transaction (only when a row was actually inserted).
  - `adminDeleteCustomer(db, customerId: string, actor: string)` — **breaking change**: third `actor` param, calls the two-arg SQL function. Return type unchanged: `{ outcome: AdminDeleteOutcome; phone?: string }`.
  - `listAuditLog(db, { page, pageSize })` → `Promise<AuditLogPage>` where `AuditLogPage = { entries: AuditLogEntry[]; total: number }` and `AuditLogEntry = { id: string; payload: unknown; createdAt: Date }` — newest first (`created_at DESC, id DESC`).

- [ ] **Step 1: Make `insertCustomer` transactional with the audit append**

Replace the existing `insertCustomer` body in `packages/db/src/customer.ts` (keep the doc comment, extend it):

```ts
/**
 * Insert a customer at registration. Idempotent under retries: `ON CONFLICT (cognito_sub) DO NOTHING`
 * means a duplicate `/auth/register` returns the existing row rather than erroring (ADR-0020).
 * A genuine insert also appends the `user_registered` audit row (0005) in the same transaction —
 * registration is the beginning of the customer's wallet, so it is an audited event; the
 * idempotent re-register path appends nothing, exactly as it inserts nothing.
 */
export async function insertCustomer(
  db: Kysely<Database>,
  input: NewCustomer,
): Promise<CustomerProfile> {
  const inserted = await db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto("customer")
      .values({
        phone_e164: input.phone,
        email: input.email ?? null,
        first_name: input.firstName,
        last_name: input.lastName,
        locale: input.locale,
        status: "active",
        cognito_sub: input.cognitoSub,
      })
      .onConflict((oc) => oc.column("cognito_sub").doNothing())
      .returning(COLUMNS)
      .executeTakeFirst();
    if (row) {
      const payload = JSON.stringify({
        type: "user_registered",
        customerId: row.id,
        phone: input.phone,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email ?? null,
      });
      await sql`SELECT audit_append(${payload}::jsonb)`.execute(trx);
    }
    return row;
  });

  if (inserted) return toProfile(inserted as CustomerRow);
  // Conflict: the row already exists for this sub — return it.
  const existing = await findByCognitoSub(db, input.cognitoSub);
  if (!existing) throw new Error("insertCustomer: conflict but no existing row");
  return existing;
}
```

(`sql` is already imported in this file.)

- [ ] **Step 2: Add the actor param to `adminDeleteCustomer`**

Replace the existing function (keep/extend its doc comment):

```ts
/**
 * Guarded hard delete for the admin users page, via the `admin_delete_customer` SECURITY DEFINER
 * function (0005): the wallet-history guard, the delete, and the `user_deleted` audit append run
 * atomically with the table owner's rights, so app_ro stays read-only at the table level.
 * `actor` (the acting admin's email/username from the JWT) lands in the audit payload. Returns
 * the deleted row's phone (for the follow-up Cognito cleanup) on success.
 */
export async function adminDeleteCustomer(
  db: Kysely<Database>,
  customerId: string,
  actor: string,
): Promise<{ outcome: AdminDeleteOutcome; phone?: string }> {
  const { rows } = await sql<{ outcome: AdminDeleteOutcome; phone: string | null }>`
    SELECT outcome, phone FROM admin_delete_customer(${customerId}::uuid, ${actor})
  `.execute(db);
  const row = rows[0];
  if (!row) throw new Error("admin_delete_customer returned no row");
  return { outcome: row.outcome, ...(row.phone ? { phone: row.phone } : {}) };
}
```

- [ ] **Step 3: Create `packages/db/src/activity.ts`**

```ts
import type { Kysely } from "kysely";
import type { Database } from "./schema";

/**
 * Audit-log read access for the admin activity feed (ADR-0003: audit_log is Aurora/money-side).
 * Read-only — every append goes through the audit_append SQL function (0005). Payloads are
 * free-form jsonb; mapping/tolerant-parsing is the caller's job (admin-api), so this layer
 * returns rows verbatim.
 */

export interface AuditLogEntry {
  id: string;
  payload: unknown;
  createdAt: Date;
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  total: number;
}

export interface ListAuditLogInput {
  /** 1-based. */
  page: number;
  pageSize: number;
}

/** Page through audit_log newest first (`created_at DESC, id DESC` — id breaks timestamp ties). */
export async function listAuditLog(
  db: Kysely<Database>,
  input: ListAuditLogInput,
): Promise<AuditLogPage> {
  const [rows, count] = await Promise.all([
    db
      .selectFrom("audit_log")
      .select(["id", "payload", "created_at"])
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize)
      .execute(),
    db
      .selectFrom("audit_log")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirst(),
  ]);

  return {
    entries: rows.map((r) => ({
      id: String(r.id),
      payload: r.payload,
      createdAt: r.created_at,
    })),
    total: Number(count?.count ?? 0),
  };
}
```

- [ ] **Step 4: Barrel exports**

In `packages/db/src/index.ts`, add before the `./customer` export block (keep alphabetical-ish grouping):

```ts
export {
  type AuditLogEntry,
  type AuditLogPage,
  type ListAuditLogInput,
  listAuditLog,
} from "./activity";
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @wanthat/db test` — expected: PASS (or "no tests", matching current state)
Run: `pnpm typecheck` — expected: **app-core is green; services/admin-api FAILS** on the `adminDeleteCustomer` call (2 args) — that is Task 6's job. If executing tasks in parallel waves, run the root typecheck only after Task 6 lands; within this task verify with `pnpm --filter @wanthat/db exec tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/customer.ts packages/db/src/activity.ts packages/db/src/index.ts
git commit -m "feat(db): registration audit append, actor on admin delete, listAuditLog"
```

---

### Task 5: Infra — dev OTP sink read for admin-api

**Files:**
- Modify: `infra/lib/admin-stack.ts`
- Modify: `infra/bin/wanthat.ts`

**Interfaces:**
- Consumes: `DataStack.devOtpSinkTable?: dynamodb.Table` (already exists; **absent in prod**), existing `AdminStackProps` + `AdminApi` NodejsFunction.
- Produces: admin-api Lambda env `DEV_OTP_SINK_TABLE` + read grant, **only when the table exists** (non-prod). Task 6's context reads that env var.

- [ ] **Step 1: Add the optional prop**

In `infra/lib/admin-stack.ts`, in `AdminStackProps` after `recommendationTable`:

```ts
  // Dev OTP sink (docs/dev-otp-sink.md) - the activity page lists parked codes in dev. Absent in
  // prod by design (the table is not provisioned there), so prod gets no env var and no grant:
  // the otp_sent feed item type structurally cannot appear in prod.
  readonly devOtpSinkTable?: dynamodb.ITable;
```

- [ ] **Step 2: Conditional env + grant**

In the `AdminApi` function's `environment` block (after `RECOMMENDATION_TABLE`):

```ts
        ...(props.devOtpSinkTable
          ? { DEV_OTP_SINK_TABLE: props.devOtpSinkTable.tableName }
          : {}),
```

After the existing grants (`props.recommendationTable.grantReadData(fn);`):

```ts
    // Dev-only: the activity feed scans the parked OTP codes (read-only; table absent in prod).
    props.devOtpSinkTable?.grantReadData(fn);
```

- [ ] **Step 3: Pass the table in the app wiring**

In `infra/bin/wanthat.ts`, inside the `new AdminStack(...)` props (after `recommendationTable: data.recommendationTable,`):

```ts
  // Dev OTP sink: activity page lists parked codes (undefined in prod - fail-closed).
  devOtpSinkTable: data.devOtpSinkTable,
```

- [ ] **Step 4: Verify**

Run: `pnpm synth`
Expected: synth succeeds; the dev admin-api function template gains `DEV_OTP_SINK_TABLE` + a dynamodb read policy statement (spot-check with `grep -A2 DEV_OTP_SINK infra/cdk.out/*admin*.template.json` or the synth output paths).

- [ ] **Step 5: Commit**

```bash
git add infra/lib/admin-stack.ts infra/bin/wanthat.ts
git commit -m "feat(infra): admin-api reads the dev OTP sink for the activity feed (non-prod)"
```

---

### Task 6: admin-api — activity endpoint, mapping, actor, dev-sink context

**Files:**
- Create: `services/admin-api/src/activity.ts`
- Create: `services/admin-api/src/activity.test.ts`
- Modify: `services/admin-api/src/context.ts`
- Modify: `services/admin-api/src/handler.ts`
- Modify: `services/admin-api/src/handler.test.ts`

**Interfaces:**
- Consumes:
  - Task 2 contracts: `ListActivityQuery`, `ActivityItem`, `ListActivityResponse` from `@wanthat/contracts`.
  - Task 4: `listAuditLog(db, {page, pageSize}) → { entries: {id: string; payload: unknown; createdAt: Date}[]; total: number }`, `adminDeleteCustomer(db, id, actor)` from `@wanthat/db`.
  - Task 3: `DevOtpSinkRepo` with `scanAll(): Promise<DevOtpSinkItem[]>` (`DevOtpSinkItem = { phone, code, channel, triggerSource, createdAt, ttl }`, `ttl` = epoch **seconds**) from `@wanthat/dynamo`.
  - Audit payload shapes from Task 1 (`user_registered` / `user_deleted` keys).
- Produces: `GET /admin/activity` returning `ListActivityResponse`. Pure helpers `auditEntryToItem`, `otpSinkToItems`, `mergeByAtDesc` (exported for tests).

- [ ] **Step 1: Write the failing unit tests — `services/admin-api/src/activity.test.ts`**

```ts
import type { DevOtpSinkItem } from "@wanthat/dynamo";
import { describe, expect, it } from "vitest";
import { auditEntryToItem, mergeByAtDesc, otpSinkToItems } from "./activity";

const AT = new Date("2026-07-08T11:32:00.000Z");

describe("auditEntryToItem", () => {
  it("maps a user_registered payload", () => {
    const item = auditEntryToItem({
      id: "7",
      createdAt: AT,
      payload: {
        type: "user_registered",
        customerId: "c-1",
        phone: "+972501234567",
        firstName: "Maya",
        lastName: "Levi",
        email: "maya@example.com",
      },
    });
    expect(item).toEqual({
      id: "audit_7",
      type: "user_registered",
      at: AT.toISOString(),
      phone: "+972501234567",
      name: "Maya Levi",
      email: "maya@example.com",
    });
  });

  it("maps a user_deleted payload with actor", () => {
    const item = auditEntryToItem({
      id: "12",
      createdAt: AT,
      payload: {
        type: "user_deleted",
        customerId: "c-1",
        phone: "+972501234567",
        firstName: "Noa",
        lastName: "Levi",
        email: null,
        actor: "dennis@wanthat.co.il",
      },
    });
    expect(item.type).toBe("user_deleted");
    expect(item.actor).toBe("dennis@wanthat.co.il");
    expect(item.name).toBe("Noa Levi");
    expect(item.email).toBeUndefined(); // null email is omitted, not ""
  });

  it("tolerates unknown types and non-object payloads", () => {
    expect(auditEntryToItem({ id: "1", createdAt: AT, payload: { type: "fx_rate_written" } })).toEqual({
      id: "audit_1",
      type: "fx_rate_written",
      at: AT.toISOString(),
    });
    expect(auditEntryToItem({ id: "2", createdAt: AT, payload: "garbage" })).toEqual({
      id: "audit_2",
      type: "unknown",
      at: AT.toISOString(),
    });
  });
});

describe("otpSinkToItems", () => {
  const nowMs = AT.getTime();
  const sinkItem: DevOtpSinkItem = {
    phone: "+972520000001",
    code: "48213976",
    channel: "whatsapp",
    triggerSource: "CustomMessage_Authentication",
    createdAt: "2026-07-08T11:30:00.000Z",
    ttl: Math.floor(nowMs / 1000) + 180, // 3 minutes left
  };

  it("maps a live item", () => {
    expect(otpSinkToItems([sinkItem], nowMs)).toEqual([
      {
        id: "otp_+972520000001",
        type: "otp_sent",
        at: "2026-07-08T11:30:00.000Z",
        phone: "+972520000001",
        channel: "whatsapp",
        code: "48213976",
        expiresAt: new Date((Math.floor(nowMs / 1000) + 180) * 1000).toISOString(),
      },
    ]);
  });

  it("drops TTL-expired items (Dynamo TTL deletion lags)", () => {
    const expired = { ...sinkItem, ttl: Math.floor(nowMs / 1000) - 1 };
    expect(otpSinkToItems([expired], nowMs)).toEqual([]);
  });
});

describe("mergeByAtDesc", () => {
  it("interleaves newest-first", () => {
    const a = { id: "audit_1", type: "user_registered", at: "2026-07-08T10:00:00.000Z" };
    const b = { id: "otp_+9", type: "otp_sent", at: "2026-07-08T11:00:00.000Z" };
    const c = { id: "audit_2", type: "user_deleted", at: "2026-07-08T09:00:00.000Z" };
    expect(mergeByAtDesc([a, c], [b]).map((i) => i.id)).toEqual(["otp_+9", "audit_1", "audit_2"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter admin-api test` (confirm the workspace name in `services/admin-api/package.json` first; adjust the filter if it is e.g. `@wanthat/admin-api`)
Expected: FAIL — `Cannot find module './activity'`

- [ ] **Step 3: Implement `services/admin-api/src/activity.ts`**

```ts
import { ActivityItem } from "@wanthat/contracts";
import type { AuditLogEntry } from "@wanthat/db";
import type { DevOtpSinkItem } from "@wanthat/dynamo";

/**
 * Pure mapping for the activity feed (I/O-free, like users-stats' buildUsersStats). Audit
 * payloads are free-form jsonb written by audit_append callers (0005); mapping is tolerant —
 * unknown types and malformed payloads still yield a renderable item, never a throw.
 */

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** audit_log row -> feed item. Known payload keys are lifted; anything else just keeps `type`. */
export function auditEntryToItem(entry: AuditLogEntry): ActivityItem {
  const p = (
    entry.payload && typeof entry.payload === "object" ? entry.payload : {}
  ) as Record<string, unknown>;
  const first = str(p.firstName);
  const last = str(p.lastName);
  const name = first || last ? [first, last].filter(Boolean).join(" ") : undefined;
  return ActivityItem.parse({
    id: `audit_${entry.id}`,
    type: str(p.type) ?? "unknown",
    at: entry.createdAt.toISOString(),
    ...(str(p.phone) ? { phone: str(p.phone) } : {}),
    ...(name ? { name } : {}),
    ...(str(p.email) ? { email: str(p.email) } : {}),
    ...(str(p.actor) ? { actor: str(p.actor) } : {}),
  });
}

/**
 * Dev sink items -> otp_sent feed items. Items past their TTL are dropped here because DynamoDB
 * TTL deletion is best-effort (can lag hours); `ttl` is epoch seconds.
 */
export function otpSinkToItems(items: DevOtpSinkItem[], nowMs: number): ActivityItem[] {
  return items
    .filter((i) => i.ttl * 1000 > nowMs)
    .map((i) =>
      ActivityItem.parse({
        id: `otp_${i.phone}`,
        type: "otp_sent",
        at: i.createdAt,
        phone: i.phone,
        channel: i.channel,
        code: i.code,
        expiresAt: new Date(i.ttl * 1000).toISOString(),
      }),
    );
}

/** Merge two newest-first lists into one, newest first (stable for equal timestamps). */
export function mergeByAtDesc(a: ActivityItem[], b: ActivityItem[]): ActivityItem[] {
  return [...a, ...b].sort((x, y) => y.at.localeCompare(x.at));
}
```

- [ ] **Step 4: Run unit tests — expected PASS**

Run: `pnpm --filter admin-api test`

- [ ] **Step 5: Wire the dev sink into the context**

`services/admin-api/src/context.ts` — extend imports, interface, and construction:

```ts
import { createDb } from "@wanthat/db";
import { DevOtpSinkRepo, getDocClient, RuntimeConfigRepo } from "@wanthat/dynamo";
```

```ts
export interface AdminContext {
  db: Db;
  config: RuntimeConfigRepo;
  /** Dev only — undefined in prod (no table, no env var; fail-closed). */
  devOtpSink?: DevOtpSinkRepo;
}
```

Replace the `cached = { … }` assignment in `getContext()` with (the `createDb` call is verbatim what is already there):

```ts
  const devOtpSinkTable = process.env.DEV_OTP_SINK_TABLE;
  cached = {
    db: createDb({
      host: requireEnv("DB_HOST"),
      port: 5432,
      database: requireEnv("DB_NAME"),
      user: requireEnv("DB_USER"),
      region,
      caCerts: process.env.DB_CA_CERT,
    }),
    config: new RuntimeConfigRepo(getDocClient(region), requireEnv("RUNTIME_CONFIG_TABLE")),
    // Dev only: DEV_OTP_SINK_TABLE is set solely where the sink table exists (never prod).
    ...(devOtpSinkTable
      ? { devOtpSink: new DevOtpSinkRepo(getDocClient(region), devOtpSinkTable) }
      : {}),
  };
```

- [ ] **Step 6: Add the route + actor to `services/admin-api/src/handler.ts`**

Extend the contracts import with `ListActivityQuery, ListActivityResponse`, the db import with `listAuditLog`, and add:

```ts
import { auditEntryToItem, mergeByAtDesc, otpSinkToItems } from "./activity";
```

Add the route after the `/admin/users` GET block:

```ts
// GET /admin/activity — one paged feed over the audit log (registrations, deletions, any future
// audited admin action), newest first. In dev the first page also merges the parked OTP codes
// from the dev sink (DEV_OTP_SINK_TABLE is only set where the table exists — never prod), so
// codes are grabbed from this panel instead of the AWS CLI. `total` counts audit rows plus the
// live sink items; page boundaries can drift by the sink size on page 1 — accepted, dev only.
app.get("/admin/activity", async (c) => {
  const query = ListActivityQuery.safeParse({
    page: c.req.query("page"),
    pageSize: c.req.query("pageSize"),
  });
  if (!query.success) return c.json({ error: "invalid_request" }, 400);
  const { page, pageSize } = query.data;
  const { entries, total } = await listAuditLog(getContext().db, { page, pageSize });
  let items = entries.map(auditEntryToItem);
  let grandTotal = total;
  const sink = getContext().devOtpSink;
  if (sink && page === 1) {
    const otp = otpSinkToItems(await sink.scanAll(), Date.now());
    items = mergeByAtDesc(items, otp);
    grandTotal += otp.length;
  }
  return c.json(ListActivityResponse.parse({ items, total: grandTotal, page, pageSize }));
});
```

In the DELETE route, resolve the actor from the JWT claims and pass it through (the audit row records who deleted; access tokens carry `username`, id tokens `email` — take what exists):

```ts
app.delete("/admin/users/:id", async (c) => {
  const id = Uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_request" }, 400);
  // biome-ignore lint/suspicious/noExplicitAny: authorizer claim shape varies by event type
  const claims = (c.env?.event as any)?.requestContext?.authorizer?.jwt?.claims ?? {};
  const actor =
    (typeof claims.email === "string" && claims.email) ||
    (typeof claims.username === "string" && claims.username) ||
    String(claims.sub ?? "unknown");
  const result = await adminDeleteCustomer(getContext().db, id.data, actor);
  if (result.outcome === "has_wallet_history") return c.json({ error: "has_wallet_history" }, 409);
  if (result.outcome === "not_found") return c.json({ error: "not_found" }, 404);
  return c.json(DeleteUserResponse.parse({ deleted: true, id: id.data, phone: result.phone }));
});
```

- [ ] **Step 7: Extend `services/admin-api/src/handler.test.ts`**

Add `listAuditLog: vi.fn()` to the hoisted `dbFns` mock. Give `adminEnv` a username claim so the actor is assertable:

```ts
const adminEnv = {
  event: {
    requestContext: {
      authorizer: {
        jwt: { claims: { "cognito:groups": ["admin"], username: "dennis@wanthat.co.il" } },
      },
    },
  },
};
```

Update the two delete-success/refusal assertions that check call args:

```ts
expect(dbFns.adminDeleteCustomer).toHaveBeenCalledWith(
  expect.anything(),
  USER.id,
  "dennis@wanthat.co.il",
);
```

Add an activity describe block:

```ts
describe("admin activity", () => {
  const ENTRY = {
    id: "7",
    createdAt: new Date("2026-07-08T11:32:00.000Z"),
    payload: {
      type: "user_registered",
      customerId: USER.id,
      phone: USER.phone,
      firstName: USER.firstName,
      lastName: USER.lastName,
      email: USER.email,
    },
  };

  it("lists audit entries as feed items", async () => {
    dbFns.listAuditLog.mockResolvedValue({ entries: [ENTRY], total: 1 });
    const res = await app.request("/admin/activity", {}, adminEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; type: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ id: "audit_7", type: "user_registered" });
    expect(dbFns.listAuditLog).toHaveBeenCalledWith(expect.anything(), { page: 1, pageSize: 20 });
  });

  it("rejects an out-of-range pageSize", async () => {
    const res = await app.request("/admin/activity?pageSize=500", {}, adminEnv);
    expect(res.status).toBe(400);
  });

  it("merges live dev-sink codes into page 1 when the sink is configured", async () => {
    dbFns.listAuditLog.mockResolvedValue({ entries: [ENTRY], total: 1 });
    ctx.devOtpSink = {
      scanAll: vi.fn().mockResolvedValue([
        {
          phone: "+972520000001",
          code: "48213976",
          channel: "whatsapp",
          triggerSource: "t",
          createdAt: "2026-07-08T11:40:00.000Z",
          ttl: Math.floor(Date.now() / 1000) + 300,
        },
      ]),
    };
    const res = await app.request("/admin/activity", {}, adminEnv);
    const body = (await res.json()) as { items: { type: string; code?: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items[0]).toMatchObject({ type: "otp_sent", code: "48213976" });
    delete ctx.devOtpSink;
  });

  it("does not merge sink codes on page 2", async () => {
    dbFns.listAuditLog.mockResolvedValue({ entries: [], total: 21 });
    ctx.devOtpSink = { scanAll: vi.fn() };
    const res = await app.request("/admin/activity?page=2", {}, adminEnv);
    expect(res.status).toBe(200);
    expect(ctx.devOtpSink.scanAll).not.toHaveBeenCalled();
    delete ctx.devOtpSink;
  });
});
```

(The hoisted `ctx` object is untyped in the test file; if TS complains about `devOtpSink`, type it `ctx: { config: …; db: {}; devOtpSink?: { scanAll: ReturnType<typeof vi.fn> } }` in the `vi.hoisted` block.)

- [ ] **Step 8: Run all admin-api tests — expected PASS**

Run: `pnpm --filter admin-api test`

- [ ] **Step 9: Commit**

```bash
git add services/admin-api/src
git commit -m "feat(admin): GET /admin/activity - audit feed with dev OTP merge, actor on delete"
```

---

### Task 7: SPA — ActivityView, nav entry, API client, i18n

**Files:**
- Create: `apps/web/src/features/admin/ActivityView.tsx`
- Modify: `apps/web/src/features/admin/AdminLayout.tsx`
- Modify: `apps/web/src/features/admin/AdminPage.tsx`
- Modify: `apps/web/src/lib/admin-api.ts`
- Modify: `apps/web/src/i18n.ts`

**Interfaces:**
- Consumes: Task 2 contracts (`ActivityItem`, `ListActivityResponse` types from `@wanthat/contracts`), existing `adminRequest` client plumbing, DS tailwind tokens (`accent-soft`, `pending`, `rejected`, `rounded-card`, `hairrow`, …), `Skeleton` from `../../ui/components`.
- Produces: `"activity"` in the `AdminView` union; `adminApi.listActivity(token, { page?, pageSize? })`.

- [ ] **Step 1: API client** — in `apps/web/src/lib/admin-api.ts`, add `ListActivityResponse` to the type-only contracts import and add to `adminApi` (after `usersStats`):

```ts
  // Activity page: paged audit-log feed (+ dev OTP codes merged server-side on page 1 in dev).
  listActivity: (token: string, opts: { page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.page) params.set("page", String(opts.page));
    if (opts.pageSize) params.set("pageSize", String(opts.pageSize));
    const qs = params.toString();
    return adminRequest<ListActivityResponse>(`/admin/activity${qs ? `?${qs}` : ""}`, token);
  },
```

- [ ] **Step 2: Nav union + sidebar item** — in `apps/web/src/features/admin/AdminLayout.tsx`:

```ts
export type AdminView = "dashboard" | "users" | "config" | "activity";
```

After the Users `NavItem` (before the Settings `NavLabel` div), add:

```tsx
        <NavItem active={view === "activity"} onClick={() => onNavigate("activity")}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <title>{t("admin.activityNav")}</title>
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          {t("admin.activityNav")}
        </NavItem>
```

- [ ] **Step 3: Page wiring** — in `apps/web/src/features/admin/AdminPage.tsx`:

Import `ActivityView`:

```ts
import { ActivityView } from "./ActivityView";
```

Extend the heading record:

```ts
    activity: { title: t("admin.activityNav"), subtitle: t("admin.activitySub") },
```

Extend the render chain:

```tsx
      {view === "dashboard" ? (
        <DashboardView token={tokens.accessToken} />
      ) : view === "users" ? (
        <UsersView token={tokens.accessToken} />
      ) : view === "activity" ? (
        <ActivityView token={tokens.accessToken} />
      ) : (
        <ConfigView token={tokens.accessToken} />
      )}
```

- [ ] **Step 4: Create `apps/web/src/features/admin/ActivityView.tsx`**

```tsx
import type { ActivityItem } from "@wanthat/contracts";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { adminApi } from "../../lib/admin-api";
import { Skeleton } from "../../ui/components";

const PAGE_SIZE = 20;

/**
 * Admin activity page: one paged feed over the audit log (registrations, deletions, future
 * audited admin actions), newest first. In dev the server merges live OTP codes from the dev
 * sink into page 1 (type "otp_sent" — never present in prod). Unknown event types render with
 * a neutral badge and the raw type string, so new audit events appear without SPA changes.
 */
export function ActivityView({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: ActivityItem[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(
    async (pageNo: number) => {
      if (!token) return;
      setLoading(true);
      setLoadFailed(false);
      try {
        const res = await adminApi.listActivity(token, { page: pageNo, pageSize: PAGE_SIZE });
        setData({ items: res.items, total: res.total });
      } catch {
        setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  const goTo = (pageNo: number) => {
    setPage(pageNo);
    void load(pageNo);
  };

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="max-w-[960px]">
      <div className="mb-4 flex items-center gap-3">
        {data ? (
          <span className="tabular text-[13px] text-muted">
            {t("admin.activityPage.pageOf", { page, pages, total: data.total })}
          </span>
        ) : null}
      </div>

      <div className="rounded-card border border-line bg-surface pb-1">
        <div className="flex items-center px-4 pb-2 pt-4 text-[11px] font-bold uppercase tracking-[0.04em] text-placeholder">
          <span className="w-[110px]">{t("admin.activityPage.time")}</span>
          <span className="w-[160px]">{t("admin.activityPage.event")}</span>
          <span className="flex-1">{t("admin.activityPage.user")}</span>
          <span className="flex-[1.3]">{t("admin.activityPage.details")}</span>
        </div>

        {loading ? (
          [0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="flex items-center border-t border-hairrow px-4 py-3"
              aria-busy="true"
            >
              <span className="w-[110px] pe-3">
                <Skeleton className="h-3.5 w-16" />
              </span>
              <span className="w-[160px] pe-3">
                <Skeleton className="h-6 w-24 rounded-full" />
              </span>
              <span className="flex-1 pe-3">
                <Skeleton className="h-3.5 w-36" />
              </span>
              <span className="flex-[1.3] pe-3">
                <Skeleton className="h-3.5 w-44" />
              </span>
            </div>
          ))
        ) : loadFailed ? (
          <div className="border-t border-hairrow px-4 py-6 text-sm text-rejected">
            {t("admin.activityPage.loadError")}
          </div>
        ) : data && data.items.length === 0 ? (
          <div className="border-t border-hairrow px-4 py-6 text-sm text-muted">
            {t("admin.activityPage.empty")}
          </div>
        ) : (
          data?.items.map((item) => <ActivityRow key={item.id} item={item} />)
        )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2.5">
        <button
          type="button"
          disabled={loading || page <= 1}
          onClick={() => goTo(page - 1)}
          className="rounded-tile border border-edge bg-surface px-4 py-2 text-[13px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("admin.activityPage.prev")}
        </button>
        <button
          type="button"
          disabled={loading || page >= pages}
          onClick={() => goTo(page + 1)}
          className="rounded-tile border border-edge bg-surface px-4 py-2 text-[13px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("admin.activityPage.next")}
        </button>
      </div>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const d = new Date(item.at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <div className="flex items-center border-t border-hairrow px-4 py-3">
      <span className="tabular w-[110px] pe-3 text-[13px]" dir="ltr">
        <span className="block font-semibold text-ink">{time}</span>
        <span className="text-muted">{date}</span>
      </span>
      <span className="w-[160px] pe-3">
        <EventBadge type={item.type} />
      </span>
      <span className="min-w-0 flex-1 pe-3">
        {item.name ? (
          <span className="block truncate text-[13.5px] font-semibold text-ink">{item.name}</span>
        ) : null}
        {item.phone ? (
          <span className="tabular block text-[12.5px] text-muted" dir="ltr">
            {item.phone}
          </span>
        ) : null}
        {!item.name && !item.phone ? <span className="text-[13px] text-muted">—</span> : null}
      </span>
      <span className="flex min-w-0 flex-[1.3] flex-wrap items-center gap-2 pe-3 text-[13px] text-muted">
        <Details item={item} />
      </span>
    </div>
  );
}

function Details({ item }: { item: ActivityItem }) {
  const { t } = useTranslation();

  if (item.type === "otp_sent") {
    const minutesLeft = item.expiresAt
      ? Math.max(0, Math.round((new Date(item.expiresAt).getTime() - Date.now()) / 60_000))
      : null;
    return (
      <>
        <span className="font-semibold text-secondary">
          {item.channel === "whatsapp" ? "WhatsApp" : "SMS"}
        </span>
        {item.code ? (
          <span
            className="tabular rounded-[9px] border border-edge bg-base px-2.5 py-1 font-mono text-[13px] font-bold tracking-[0.12em] text-ink"
            dir="ltr"
          >
            {item.code}
          </span>
        ) : null}
        {minutesLeft !== null ? (
          <span className="text-[11.5px] text-placeholder">
            {minutesLeft > 0
              ? t("admin.activityPage.expiresIn", { minutes: minutesLeft })
              : t("admin.activityPage.expired")}
          </span>
        ) : null}
      </>
    );
  }

  if (item.type === "user_deleted" && item.actor) {
    return (
      <span>
        {t("admin.activityPage.deletedBy", { actor: item.actor })}
        <span className="text-placeholder"> · {item.id.replace("audit_", "#")}</span>
      </span>
    );
  }

  return <span>—</span>;
}

function EventBadge({ type }: { type: string }) {
  const { t } = useTranslation();

  if (type === "user_registered") {
    return (
      <Badge className="bg-accent-soft text-accent">{t("admin.activityPage.registered")}</Badge>
    );
  }
  if (type === "user_deleted") {
    return (
      <Badge className="bg-rejected-soft text-rejected">{t("admin.activityPage.deleted")}</Badge>
    );
  }
  if (type === "otp_sent") {
    return (
      <Badge className="bg-pending-soft text-pending">
        {t("admin.activityPage.otpSent")}
        <span className="ms-0.5 rounded-md bg-pending px-1.5 py-px text-[10px] font-extrabold tracking-[0.08em] text-white">
          {t("admin.activityPage.dev")}
        </span>
      </Badge>
    );
  }
  // Unknown/future audit types render generically - new events need no SPA change.
  return <Badge className="bg-base text-secondary">{type}</Badge>;
}

function Badge({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] font-bold ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
```


- [ ] **Step 5: i18n keys** — in `apps/web/src/i18n.ts`, add to the **en** admin block (after `usersPage`, i.e. after line ~138):

```ts
    activityNav: "Activity",
    activitySub: "Audit log and user activity, newest first",
    activityPage: {
      time: "Time",
      event: "Event",
      user: "User",
      details: "Details",
      empty: "No activity yet.",
      loadError: "Couldn't load activity.",
      pageOf: "Page {{page}} of {{pages}} · {{total}} events",
      prev: "Previous",
      next: "Next",
      registered: "Registered",
      deleted: "User deleted",
      otpSent: "OTP sent",
      dev: "DEV",
      deletedBy: "by {{actor}}",
      expiresIn: "expires in {{minutes}} min",
      expired: "expired",
    },
```

And the parallel **he** admin block (after its `usersPage`, ~line 379):

```ts
    activityNav: "פעילות",
    activitySub: "יומן ביקורת ופעילות משתמשים, מהחדש לישן",
    activityPage: {
      time: "זמן",
      event: "אירוע",
      user: "משתמש",
      details: "פרטים",
      empty: "אין פעילות עדיין.",
      loadError: "טעינת הפעילות נכשלה.",
      pageOf: "עמוד {{page}} מתוך {{pages}} · {{total}} אירועים",
      prev: "הקודם",
      next: "הבא",
      registered: "נרשם/ה",
      deleted: "משתמש נמחק",
      otpSent: "קוד נשלח",
      dev: "DEV",
      deletedBy: "על ידי {{actor}}",
      expiresIn: "פג בעוד {{minutes}} דק'",
      expired: "פג תוקף",
    },
```

- [ ] **Step 6: Verify**

Run: `pnpm --filter web test` (confirm workspace name in `apps/web/package.json`; adjust filter) — expected: PASS (i18n completeness tests, if present, must see both locales)
Run: `pnpm typecheck` — expected: clean **once Tasks 2, 4, 6 are in the tree** (this task + Task 6 together clear the `adminDeleteCustomer` signature change).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): admin activity page - paged audit feed with dev OTP codes"
```

---

### Task 8: Integration verification + PR (orchestrator, not a subagent)

- [ ] **Step 1: Full pipeline**

Run: `pnpm build && pnpm typecheck && pnpm test && pnpm synth`
Expected: all green. If `cdk diff` is runnable with current creds: `pnpm diff` — expected changes only: admin-api env+policy (dev), db-migrator asset hash (0005).

- [ ] **Step 2: Cross-task consistency check**

- `adminDeleteCustomer(db, id, actor)` — Task 4 signature matches Task 6 call sites and handler tests.
- `listAuditLog` return `{entries, total}` — matches Task 6 usage.
- `scanAll()` — matches Task 6 context/route usage.
- Contract field names (`expiresAt`, `channel`, `code`) — match Task 7's rendering.

- [ ] **Step 3: PR**

Push branch `feat/admin-activity-page`, open a **ready** PR (not draft) titled
`feat(admin): activity page - audit-log feed with registrations, deletions, dev OTP codes`,
body summarising the slice + link to the spec; CI + Check Deploy must pass (red check-deploy is blocking).
