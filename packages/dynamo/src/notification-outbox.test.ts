import { describe, expect, it, vi } from "vitest";
import { NotificationOutboxRepo } from "./notification-outbox";

const item = {
  outboxId: "ob-1",
  customerId: "sub-1",
  phone: "+972541234567",
  messageType: "optin_welcome" as const,
  language: "he" as const,
  variables: { firstName: "Dana", appUrl: "https://dev.wanthat.app" },
  status: "pending" as const,
  createdAt: "2026-07-02T00:00:00.000Z",
  ttl: 1754000000,
};

function repo() {
  const send = vi.fn().mockResolvedValue({});
  return { repo: new NotificationOutboxRepo({ send } as never, "outbox"), send };
}

describe("NotificationOutboxRepo", () => {
  it("puts a pending item", async () => {
    const { repo: r, send } = repo();
    await r.put(item);
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({ TableName: "outbox", Item: item });
  });

  it("gets an item back (undefined when absent)", async () => {
    const { repo: r, send } = repo();
    send.mockResolvedValue({ Item: item });
    expect(await r.get("ob-1")).toEqual(item);
    send.mockResolvedValue({});
    expect(await r.get("ob-2")).toBeUndefined();
  });

  it("markSent / markFailed update status (+ error) by outboxId", async () => {
    const { repo: r, send } = repo();
    await r.markSent("ob-1");
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({
      Key: { outboxId: "ob-1" },
      ExpressionAttributeValues: expect.objectContaining({ ":status": "sent" }),
    });
    await r.markFailed("ob-1", "template not approved");
    expect(send.mock.calls[1]?.[0]?.input.ExpressionAttributeValues).toMatchObject({
      ":status": "failed",
      ":error": "template not approved",
    });
  });
});
