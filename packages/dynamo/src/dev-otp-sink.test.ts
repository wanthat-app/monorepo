import { describe, expect, it, vi } from "vitest";
import { DevOtpSinkRepo } from "./dev-otp-sink";

const item = {
  phone: "+972541234567",
  code: "12345678",
  channel: "sms" as const,
  triggerSource: "CustomSMSSender_Authentication",
  createdAt: "2026-07-02T00:00:00.000Z",
  ttl: 1782996300,
};

describe("DevOtpSinkRepo", () => {
  it("puts and gets a sink item by phone", async () => {
    const send = vi.fn().mockResolvedValue({});
    const repo = new DevOtpSinkRepo({ send } as never, "sink");
    await repo.put(item);
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({ TableName: "sink", Item: item });
    send.mockResolvedValue({ Item: item });
    expect(await repo.get("+972541234567")).toEqual(item);
    send.mockResolvedValue({});
    expect(await repo.get("+972000000000")).toBeUndefined();
  });
});
