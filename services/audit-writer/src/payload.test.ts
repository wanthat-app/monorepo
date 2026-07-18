import { AuditWriteRequest } from "@wanthat/contracts";
import { describe, expect, it } from "vitest";
import { auditPayload } from "./payload";

const SUB = "11111111-1111-1111-1111-111111111111";
const ACTOR = "admin@wanthat.app";

describe("auditPayload", () => {
  it("mirrors the 0007 wrapper's jsonb for config_changed (the feed parses this shape)", () => {
    const request = AuditWriteRequest.parse({
      event: "config_changed",
      key: "auth.smsEnabled",
      value: false,
      previous: true,
      actor: ACTOR,
    });
    expect(auditPayload(request)).toEqual({
      type: "config_changed",
      key: "auth.smsEnabled",
      value: false,
      previous: true,
      actor: ACTOR,
    });
  });

  it("coalesces absent config values to JSON null, exactly like the SQL wrapper did", () => {
    const request = AuditWriteRequest.parse({
      event: "config_changed",
      key: "landing.countdownSeconds",
      value: 5,
      actor: ACTOR,
    });
    const payload = auditPayload(request);
    expect(payload.previous).toBeNull();
    // JSON.stringify must keep the key (undefined would drop it from the chained jsonb).
    expect(JSON.parse(JSON.stringify(payload))).toHaveProperty("previous", null);
  });

  it("shapes user_registered as {type, sub} — NO member PII ever enters the chain", () => {
    const request = AuditWriteRequest.parse({ event: "user_registered", sub: SUB });
    expect(auditPayload(request)).toStrictEqual({ type: "user_registered", sub: SUB });
  });

  it("strips profile fields a caller smuggles into user_registered (Zod drops unknown keys)", () => {
    const request = AuditWriteRequest.parse({
      event: "user_registered",
      sub: SUB,
      phone: "+972501234567",
      email: "dana@example.com",
    });
    expect(auditPayload(request)).toStrictEqual({ type: "user_registered", sub: SUB });
  });

  it.each([
    "user_deleted",
    "user_disabled",
    "user_enabled",
    "user_signed_out",
  ] as const)("shapes %s as {type, sub, actor}", (event) => {
    const request = AuditWriteRequest.parse({ event, sub: SUB, actor: ACTOR });
    expect(auditPayload(request)).toEqual({ type: event, sub: SUB, actor: ACTOR });
  });

  it("rejects an unknown event kind at the contract boundary", () => {
    expect(() => AuditWriteRequest.parse({ event: "wallet_entry", sub: SUB })).toThrow();
  });
});
