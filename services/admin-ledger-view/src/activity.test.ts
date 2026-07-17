import { describe, expect, it } from "vitest";
import { auditEntryToItem } from "./activity";

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

  it("maps a config_changed payload with key, value transition and actor", () => {
    const item = auditEntryToItem({
      id: "20",
      createdAt: AT,
      payload: {
        type: "config_changed",
        key: "auth.smsEnabled",
        value: false,
        previous: true,
        actor: "dennis@wanthat.co.il",
      },
    });
    expect(item).toEqual({
      id: "audit_20",
      type: "config_changed",
      at: AT.toISOString(),
      key: "auth.smsEnabled",
      value: false,
      previous: true,
      actor: "dennis@wanthat.co.il",
    });
  });

  it("maps a moderation payload (sub + actor) written by admin-console via audit-writer", () => {
    const item = auditEntryToItem({
      id: "31",
      createdAt: AT,
      payload: {
        type: "user_disabled",
        sub: "3f1c9a2e-0000-4000-8000-000000000000",
        actor: "dennis@wanthat.co.il",
      },
    });
    expect(item).toEqual({
      id: "audit_31",
      type: "user_disabled",
      at: AT.toISOString(),
      actor: "dennis@wanthat.co.il",
    });
  });

  it("tolerates unknown types and non-object payloads", () => {
    expect(
      auditEntryToItem({ id: "1", createdAt: AT, payload: { type: "fx_rate_written" } }),
    ).toEqual({
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
