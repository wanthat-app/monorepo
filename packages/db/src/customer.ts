import { CustomerProfile } from "@wanthat/contracts";
import type { Kysely } from "kysely";
import type { Database } from "./schema";

/**
 * Customer (PII) data access (ADR-0003, ADR-0020) — the only writer/reader of the Aurora `customer`
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
 * means a duplicate `/auth/register` returns the existing row rather than erroring (ADR-0020).
 */
export async function insertCustomer(
  db: Kysely<Database>,
  input: NewCustomer,
): Promise<CustomerProfile> {
  const inserted = await db
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
