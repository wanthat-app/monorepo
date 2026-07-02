import { marshall } from "@aws-sdk/util-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DispatchDeps, dispatchRecord } from "./dispatch";

const item = {
  outboxId: "ob-1",
  customerId: "sub-1",
  phone: "+972541234567",
  messageType: "optin_welcome",
  language: "he",
  variables: { firstName: "Dana", appUrl: "https://dev.wanthat.app" },
  status: "pending",
  createdAt: "2026-07-02T00:00:00.000Z",
  ttl: 1754000000,
};

const record = (overrides: Record<string, unknown> = {}, eventName = "INSERT") => ({
  eventName,
  dynamodb: { NewImage: marshall({ ...item, ...overrides }) },
});

const deps = {
  config: { get: vi.fn() },
  outbox: { get: vi.fn(), markSent: vi.fn(), markFailed: vi.fn() },
  whatsapp: { sendTemplate: vi.fn().mockResolvedValue({ messageId: "wamid.X" }) },
  log: vi.fn(),
} satisfies DispatchDeps;

beforeEach(() => {
  vi.clearAllMocks();
  deps.whatsapp.sendTemplate.mockResolvedValue({ messageId: "wamid.X" });
  deps.config.get.mockImplementation((key: string) =>
    Promise.resolve(
      {
        "notifications.whatsappEnabled": true,
        "whatsapp.phoneNumberId": "phone-number-id-test",
      }[key],
    ),
  );
  deps.outbox.get.mockResolvedValue(item);
});

describe("dispatchRecord", () => {
  it("sends a pending item and marks it sent", async () => {
    await dispatchRecord(deps, record());
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith({
      phoneNumberId: "phone-number-id-test",
      type: "optin_welcome" as const,
      language: "he",
      variables: item.variables,
      to: item.phone,
    });
    expect(deps.outbox.markSent).toHaveBeenCalledWith("ob-1");
    // Chain link: outboxId ties this to app-core's optin_welcome_enqueued; messageId to Meta.
    expect(deps.log).toHaveBeenCalledWith("notification_sent", {
      outboxId: "ob-1",
      messageId: "wamid.X",
    });
  });

  it("skips non-INSERT events and non-pending items (idempotent at-least-once)", async () => {
    await dispatchRecord(deps, record({}, "MODIFY"));
    await dispatchRecord(deps, record({ status: "sent" }));
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("skips (leaves pending) when notifications are disabled or the phoneNumberId is unset", async () => {
    deps.config.get.mockImplementation((key: string) =>
      Promise.resolve(
        {
          "notifications.whatsappEnabled": false,
          "whatsapp.phoneNumberId": "x",
        }[key],
      ),
    );
    await dispatchRecord(deps, record());
    deps.config.get.mockImplementation((key: string) =>
      Promise.resolve(
        {
          "notifications.whatsappEnabled": true,
          "whatsapp.phoneNumberId": "",
        }[key],
      ),
    );
    await dispatchRecord(deps, record());
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(deps.outbox.markSent).not.toHaveBeenCalled();
    expect(deps.outbox.markFailed).not.toHaveBeenCalled();
    expect(deps.outbox.get).not.toHaveBeenCalled();
  });

  it("skips a replayed record whose TABLE status is no longer pending", async () => {
    deps.outbox.get.mockResolvedValue({ ...item, status: "sent" });
    await dispatchRecord(deps, record());
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(deps.outbox.markSent).not.toHaveBeenCalled();
    expect(deps.outbox.markFailed).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("notification_skipped_not_pending", {
      outboxId: "ob-1",
    });
  });

  it("propagates a get() failure (infra error → event-source retry)", async () => {
    deps.outbox.get.mockRejectedValue(new Error("dynamo down"));
    await expect(dispatchRecord(deps, record())).rejects.toThrow("dynamo down");
  });

  it("marks failed (and does NOT throw) on a send-submission error", async () => {
    deps.whatsapp.sendTemplate.mockRejectedValue(new Error("template not approved"));
    await dispatchRecord(deps, record());
    expect(deps.outbox.markFailed).toHaveBeenCalledWith("ob-1", "template not approved");
  });

  it("THROWS on an infrastructure error so the event source retries/bisects to the DLQ", async () => {
    deps.config.get.mockRejectedValue(new Error("dynamo down"));
    await expect(dispatchRecord(deps, record())).rejects.toThrow("dynamo down");
  });
});
