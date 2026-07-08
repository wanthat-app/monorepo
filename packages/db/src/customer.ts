import { CustomerProfile } from "@wanthat/contracts";
import { type Kysely, sql } from "kysely";
import type { Database } from "./schema";

/**
 * Customer (PII) data access (ADR-0003, ADR-0006) — the only writer/reader of the Aurora `customer`
 * table outside migrations. Rows are mapped to the `CustomerProfile` contract and **Zod-validated**
 * on the way out, so a malformed row fails loudly at the boundary rather than leaking a bad shape.
 *
 * `cognito_sub` is the identity anchor: `/me` and every member-scoped read resolves by it.
 */

interface CustomerRow {
  id: string;
  phone_e164: string;
  email: string | null;
  first_name: string;
  last_name: string;
  locale: string;
  status: "active" | "suspended";
  created_at: Date;
  updated_at: Date;
}

/** Map + validate a DB row to the public profile contract. */
export function toProfile(row: CustomerRow): CustomerProfile {
  return CustomerProfile.parse({
    id: row.id,
    phone: row.phone_e164,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    locale: row.locale,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

const COLUMNS = [
  "id",
  "phone_e164",
  "email",
  "first_name",
  "last_name",
  "locale",
  "status",
  "created_at",
  "updated_at",
] as const;

export async function findByCognitoSub(
  db: Kysely<Database>,
  cognitoSub: string,
): Promise<CustomerProfile | undefined> {
  const row = await db
    .selectFrom("customer")
    .select(COLUMNS)
    .where("cognito_sub", "=", cognitoSub)
    .executeTakeFirst();
  return row ? toProfile(row as CustomerRow) : undefined;
}

export async function findByPhone(
  db: Kysely<Database>,
  phone: string,
): Promise<CustomerProfile | undefined> {
  const row = await db
    .selectFrom("customer")
    .select(COLUMNS)
    .where("phone_e164", "=", phone)
    .executeTakeFirst();
  return row ? toProfile(row as CustomerRow) : undefined;
}

export interface NewCustomer {
  cognitoSub: string;
  phone: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  locale: string;
}

/**
 * Insert a customer at registration. Idempotent under retries: `ON CONFLICT (cognito_sub) DO NOTHING`
 * means a duplicate `/auth/register` returns the existing row rather than erroring (ADR-0006).
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

export interface ProfilePatch {
  firstName?: string;
  lastName?: string;
  locale?: string;
  email?: string | null;
}

/** Update mutable profile fields by Cognito sub; returns the updated profile (or undefined if none). */
export async function updateProfile(
  db: Kysely<Database>,
  cognitoSub: string,
  patch: ProfilePatch,
): Promise<CustomerProfile | undefined> {
  const updated = await db
    .updateTable("customer")
    .set({
      updated_at: new Date(),
      ...(patch.firstName !== undefined ? { first_name: patch.firstName } : {}),
      ...(patch.lastName !== undefined ? { last_name: patch.lastName } : {}),
      ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
    })
    .where("cognito_sub", "=", cognitoSub)
    .returning(COLUMNS)
    .executeTakeFirst();
  return updated ? toProfile(updated as CustomerRow) : undefined;
}

export interface ListCustomersInput {
  /** Free-text match against phone (E.164) and email, case-insensitive substring. */
  search?: string;
  /** 1-based. */
  page: number;
  pageSize: number;
}

export interface CustomerPage {
  users: CustomerProfile[];
  total: number;
}

/** Escape LIKE metacharacters so a search for "100%" doesn't become a wildcard. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Page through customers for the admin console, newest first. `search` narrows by phone or email
 * (substring, case-insensitive); `total` counts the same filtered set so the caller can page.
 */
export async function listCustomers(
  db: Kysely<Database>,
  input: ListCustomersInput,
): Promise<CustomerPage> {
  const term = input.search?.trim();
  const filter = term ? `%${escapeLike(term)}%` : undefined;
  const filtered = db
    .selectFrom("customer")
    .$if(filter !== undefined, (qb) =>
      qb.where((eb) =>
        eb.or([
          eb("phone_e164", "ilike", filter as string),
          eb("email", "ilike", filter as string),
        ]),
      ),
    );

  const [rows, count] = await Promise.all([
    filtered
      .select(COLUMNS)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize)
      .execute(),
    filtered.select((eb) => eb.fn.countAll<string>().as("count")).executeTakeFirst(),
  ]);

  return {
    users: rows.map((r) => toProfile(r as CustomerRow)),
    total: Number(count?.count ?? 0),
  };
}

export type AdminDeleteOutcome = "deleted" | "not_found" | "has_wallet_history";

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
