import { describe, expect, it } from "vitest";
import {
  AdminUserItem,
  CognitoDeleteUserResponse,
  DisableUserBody,
  DisableUserResponse,
  EnableUserBody,
  GlobalSignOutUserBody,
  GlobalSignOutUserResponse,
  ListUsersQuery,
  ListUsersResponse,
} from "./admin-users";

describe("admin ban tooling contracts (ADR-0006 decision 8)", () => {
  it("identifies the user by E.164 phone — the pool's username", () => {
    expect(DisableUserBody.safeParse({ phone: "+972541234567" }).success).toBe(true);
    expect(EnableUserBody.safeParse({ phone: "+972541234567" }).success).toBe(true);
    expect(GlobalSignOutUserBody.safeParse({ phone: "+972541234567" }).success).toBe(true);
  });

  it("rejects non-E.164 identifiers (no sub, no bare digits)", () => {
    expect(DisableUserBody.safeParse({ phone: "0541234567" }).success).toBe(false);
    expect(
      DisableUserBody.safeParse({ phone: "3f1c9a2e-0000-4000-8000-000000000000" }).success,
    ).toBe(false);
    expect(GlobalSignOutUserBody.safeParse({}).success).toBe(false);
  });

  it("responses are a bare ok literal", () => {
    expect(DisableUserResponse.parse({ ok: true })).toEqual({ ok: true });
    expect(GlobalSignOutUserResponse.safeParse({ ok: false }).success).toBe(false);
  });
});

const USER = {
  id: "3f1c9a2e-0000-4000-8000-000000000000", // Cognito sub
  phone: "+972541234567",
  email: null,
  firstName: "",
  lastName: "",
  locale: "he-IL",
  status: "suspended",
  userStatus: "CONFIRMED",
  createdAt: "2026-07-09T10:00:00.000Z",
  updatedAt: "2026-07-09T10:00:00.000Z",
};

describe("admin users list contracts (Cognito ListUsers, ADR-0006)", () => {
  it("accepts a pool user with empty names and a Cognito lifecycle state", () => {
    expect(AdminUserItem.parse(USER)).toEqual(USER);
  });

  it("query is token-paged with Cognito's Limit cap (60), no random-access page", () => {
    expect(ListUsersQuery.parse({})).toEqual({ pageSize: 20 });
    expect(ListUsersQuery.parse({ search: "+9725", pageSize: "60", nextToken: "tok" })).toEqual({
      search: "+9725",
      pageSize: 60,
      nextToken: "tok",
    });
    expect(ListUsersQuery.safeParse({ pageSize: 61 }).success).toBe(false);
  });

  it("response carries the approximate pool total and the forward-only token", () => {
    const parsed = ListUsersResponse.parse({
      users: [USER],
      total: 41,
      approximate: true,
      nextToken: "tok",
    });
    expect(parsed.total).toBe(41);
    expect(ListUsersResponse.safeParse({ users: [], total: 0, approximate: false }).success).toBe(
      false,
    );
  });

  it("cognito-delete answers a bare {ok, existed} — deletion keeps the member's data", () => {
    // ADR-0006 d8 amended 2026-07-18: no recommendationsDeleted — nothing is erased; a
    // legacy client sending the old field is simply stripped by the schema.
    expect(
      CognitoDeleteUserResponse.parse({ ok: true, existed: true, recommendationsDeleted: 3 }),
    ).toEqual({ ok: true, existed: true });
    // Already-gone account (idempotent retry): not an error.
    expect(CognitoDeleteUserResponse.parse({ ok: true, existed: false })).toEqual({
      ok: true,
      existed: false,
    });
  });
});
