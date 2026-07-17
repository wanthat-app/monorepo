import type { OtpSinkItem } from "@wanthat/dynamo";
import { describe, expect, it } from "vitest";
import { otpSinkToItems } from "./otp-sink";

const AT = new Date("2026-07-08T11:32:00.000Z");

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

  it("orders newest first", () => {
    const older = { ...sinkItem, phone: "+972520000002", createdAt: "2026-07-08T11:20:00.000Z" };
    const items = otpSinkToItems([older, sinkItem], nowMs);
    expect(items.map((i) => i.phone)).toEqual(["+972520000001", "+972520000002"]);
  });
});
