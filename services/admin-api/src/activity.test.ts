import type { OtpSinkItem } from "@wanthat/dynamo";
import { describe, expect, it } from "vitest";
import { auditEntryToItem, mergeByAtDesc, otpSinkToItems, outboxToItems } from "./activity";

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

describe("otpSinkToItems", () => {
  const nowMs = AT.getTime();
  const sinkItem: OtpSinkItem = {
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

describe("outboxToItems", () => {
  const nowMs = Date.parse("2026-07-11T18:00:00.000Z");
  const outboxItem = {
    outboxId: "ob-1",
    customerId: "11111111-1111-1111-1111-111111111111",
    phone: "+972520000002",
    messageType: "optin_welcome" as const,
    language: "he" as const,
    variables: { firstName: "Maya", appUrl: "https://dev.wanthat.app" },
    status: "sent" as const,
    createdAt: "2026-07-11T17:00:00.000Z",
    ttl: Math.floor(nowMs / 1000) + 3600,
  };

  it("maps a signup to a user_registered row (name from variables)", () => {
    expect(outboxToItems([outboxItem], nowMs)).toEqual([
      {
        id: "signup_ob-1",
        type: "user_registered",
        at: "2026-07-11T17:00:00.000Z",
        phone: "+972520000002",
        name: "Maya",
      },
    ]);
  });

  it("drops TTL-expired items and omits an empty name", () => {
    const expired = { ...outboxItem, ttl: Math.floor(nowMs / 1000) - 1 };
    expect(outboxToItems([expired], nowMs)).toEqual([]);
    const nameless = { ...outboxItem, variables: { firstName: "", appUrl: "x" } };
    expect(outboxToItems([nameless], nowMs)[0]).not.toHaveProperty("name");
  });
});

describe("auditEntryToItem — wallet_entry details", () => {
  it("lifts order + money fields", () => {
    const item = auditEntryToItem({
      id: 7,
      createdAt: new Date("2026-07-11T18:21:00.000Z"),
      payload: {
        type: "wallet_entry",
        kind: "referrer_cashback",
        status: "pending",
        amountMinor: "62",
        currency: "USD",
        orderId: "112163",
        cognitoSub: "22222222-2222-2222-2222-222222222222",
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal AuditLogEntry shape for the mapper
    } as any);
    expect(item).toMatchObject({
      type: "wallet_entry",
      kind: "referrer_cashback",
      status: "pending",
      amountMinor: "62",
      currency: "USD",
      orderId: "112163",
    });
  });
});
