import { describe, expect, it } from "vitest";
import {
  DisableUserBody,
  DisableUserResponse,
  EnableUserBody,
  GlobalSignOutUserBody,
  GlobalSignOutUserResponse,
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
