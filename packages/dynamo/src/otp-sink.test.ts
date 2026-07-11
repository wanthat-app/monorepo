import { describe, expect, it, vi } from "vitest";
import { OtpSinkRepo } from "./otp-sink";

const item = {
  phone: "+972541234567",
  code: "12345678",
  channel: "sms" as const,
  triggerSource: "CustomSMSSender_Authentication",
  createdAt: "2026-07-02T00:00:00.000Z",
  ttl: 1782996300,
};

describe("OtpSinkRepo", () => {
  it("puts and gets a sink item by phone", async () => {
    const send = vi.fn().mockResolvedValue({});
    const repo = new OtpSinkRepo({ send } as never, "sink");
    await repo.put(item);
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({ TableName: "sink", Item: item });
    send.mockResolvedValue({ Item: item });
    expect(await repo.get("+972541234567")).toEqual(item);
    send.mockResolvedValue({});
    expect(await repo.get("+972000000000")).toBeUndefined();
  });

  it("scanAll returns every parked item", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [item] });
    const repo = new OtpSinkRepo({ send } as never, "sink");
    const items = await repo.scanAll();
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({ TableName: "sink" });
    expect(items).toEqual([expect.objectContaining({ phone: "+972541234567" })]);
  });
});
