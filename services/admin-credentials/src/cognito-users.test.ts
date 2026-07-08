import {
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminGetUserCommand,
  type CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  ListUsersCommand,
  UserNotFoundException,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, it, vi } from "vitest";
import { CognitoUserAdmin, toAdminUserItem } from "./cognito-users";

const SUB = "3f1c9a2e-0000-4000-8000-000000000000";
const CREATED = new Date("2026-07-09T10:00:00.000Z");

function poolUser(overrides: Partial<UserType> = {}): UserType {
  return {
    Username: "+972501234567",
    Enabled: true,
    UserStatus: "CONFIRMED",
    UserCreateDate: CREATED,
    UserLastModifiedDate: CREATED,
    Attributes: [
      { Name: "sub", Value: SUB },
      { Name: "phone_number", Value: "+972501234567" },
      { Name: "given_name", Value: "Maya" },
      { Name: "family_name", Value: "Levi" },
      { Name: "email", Value: "maya@example.com" },
      { Name: "locale", Value: "he-IL" },
    ],
    ...overrides,
  };
}

const notFound = () => new UserNotFoundException({ message: "no user", $metadata: {} });

function fakeClient(send: ReturnType<typeof vi.fn>): CognitoIdentityProviderClient {
  return { send } as unknown as CognitoIdentityProviderClient;
}

describe("toAdminUserItem", () => {
  it("maps Cognito attributes onto the contract row", () => {
    expect(toAdminUserItem(poolUser())).toEqual({
      id: SUB,
      phone: "+972501234567",
      email: "maya@example.com",
      firstName: "Maya",
      lastName: "Levi",
      locale: "he-IL",
      status: "active",
      userStatus: "CONFIRMED",
      createdAt: "2026-07-09T10:00:00.000Z",
      updatedAt: "2026-07-09T10:00:00.000Z",
    });
  });

  it("derives suspended from Enabled=false and defaults optional attributes", () => {
    const row = toAdminUserItem(
      poolUser({
        Enabled: false,
        Attributes: [
          { Name: "sub", Value: SUB },
          { Name: "phone_number", Value: "+972501234567" },
        ],
      }),
    );
    expect(row).toMatchObject({
      status: "suspended",
      email: null,
      firstName: "",
      lastName: "",
      locale: "he-IL",
    });
  });

  it("drops a row it cannot represent instead of throwing", () => {
    expect(toAdminUserItem(poolUser({ Attributes: [] }))).toBeUndefined();
  });
});

describe("CognitoUserAdmin", () => {
  it("list: prefix filter + token paging + approximate pool total", async () => {
    const send = vi.fn(async (cmd: object) => {
      if (cmd instanceof ListUsersCommand) return { Users: [poolUser()], PaginationToken: "tok2" };
      if (cmd instanceof DescribeUserPoolCommand)
        return { UserPool: { EstimatedNumberOfUsers: 41 } };
      throw new Error("unexpected command");
    });
    const admin = new CognitoUserAdmin(fakeClient(send), "pool-1");
    const page = await admin.list({ phonePrefix: '+9725"\\', limit: 20, nextToken: "tok1" });
    expect(page.total).toBe(41);
    expect(page.approximate).toBe(true);
    expect(page.nextToken).toBe("tok2");
    expect(page.users).toHaveLength(1);
    const listCmd = send.mock.calls.map((c) => c[0]).find((c) => c instanceof ListUsersCommand);
    // Quote/backslash are stripped, not escaped - they cannot appear in an E.164 prefix.
    expect((listCmd as ListUsersCommand).input).toMatchObject({
      UserPoolId: "pool-1",
      Limit: 20,
      PaginationToken: "tok1",
      Filter: 'phone_number ^= "+9725"',
    });
  });

  it("lifecycle actions resolve false for an unknown phone (contract: 404)", async () => {
    const send = vi.fn().mockRejectedValue(notFound());
    const admin = new CognitoUserAdmin(fakeClient(send), "pool-1");
    expect(await admin.disable("+972501234567")).toBe(false);
    expect(await admin.enable("+972501234567")).toBe(false);
    expect(await admin.globalSignOut("+972501234567")).toBe(false);
  });

  it("disable sends AdminDisableUser keyed by phone and resolves true", async () => {
    const send = vi.fn().mockResolvedValue({});
    const admin = new CognitoUserAdmin(fakeClient(send), "pool-1");
    expect(await admin.disable("+972501234567")).toBe(true);
    const cmd = send.mock.calls[0]?.[0] as AdminDisableUserCommand;
    expect(cmd).toBeInstanceOf(AdminDisableUserCommand);
    expect(cmd.input).toEqual({ UserPoolId: "pool-1", Username: "+972501234567" });
  });

  it("remove resolves the sub via AdminGetUser BEFORE deleting", async () => {
    const order: string[] = [];
    const send = vi.fn(async (cmd: object) => {
      if (cmd instanceof AdminGetUserCommand) {
        order.push("get");
        return { Username: "+972501234567", UserAttributes: [{ Name: "sub", Value: SUB }] };
      }
      if (cmd instanceof AdminDeleteUserCommand) {
        order.push("delete");
        return {};
      }
      throw new Error("unexpected command");
    });
    const admin = new CognitoUserAdmin(fakeClient(send), "pool-1");
    expect(await admin.remove("+972501234567")).toEqual({ existed: true, sub: SUB });
    expect(order).toEqual(["get", "delete"]);
  });

  it("remove treats an already-gone account as existed:false with no sub", async () => {
    const send = vi.fn().mockRejectedValue(notFound());
    const admin = new CognitoUserAdmin(fakeClient(send), "pool-1");
    expect(await admin.remove("+972501234567")).toEqual({ existed: false });
  });
});
