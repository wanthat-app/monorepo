import { beforeEach, describe, expect, it, vi } from "vitest";
import { type SendDeps, sendNotification } from "./send";

const request = {
  messageType: "optin_welcome",
  phone: "+972541234567",
  language: "he",
  variables: { firstName: "Dana", appUrl: "https://dev.wanthat.app" },
};

const deps = {
  config: { get: vi.fn() },
  whatsapp: { sendTemplate: vi.fn() },
  log: vi.fn(),
} satisfies SendDeps;

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
});

describe("sendNotification", () => {
  it("sends the template for a valid payload", async () => {
    await sendNotification(deps, request);
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith({
      phoneNumberId: "phone-number-id-test",
      type: "optin_welcome" as const,
      language: "he",
      variables: request.variables,
      to: request.phone,
    });
    // messageId is Meta's wamid — the handle for correlating delivery-status webhooks later.
    expect(deps.log).toHaveBeenCalledWith("notification_sent", {
      messageType: "optin_welcome",
      messageId: "wamid.X",
    });
  });

  it("rejects a malformed payload (THROWS -> async retry -> DLQ carries the real payload)", async () => {
    await expect(sendNotification(deps, { messageType: "optin_welcome" })).rejects.toThrow();
    await expect(sendNotification(deps, { ...request, phone: "0541234567" })).rejects.toThrow();
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("logs and RETURNS SUCCESS when the kill switch is off or the phoneNumberId is unset", async () => {
    deps.config.get.mockImplementation((key: string) =>
      Promise.resolve(
        {
          "notifications.whatsappEnabled": false,
          "whatsapp.phoneNumberId": "x",
        }[key],
      ),
    );
    await expect(sendNotification(deps, request)).resolves.toBeUndefined();
    deps.config.get.mockImplementation((key: string) =>
      Promise.resolve(
        {
          "notifications.whatsappEnabled": true,
          "whatsapp.phoneNumberId": "",
        }[key],
      ),
    );
    await expect(sendNotification(deps, request)).resolves.toBeUndefined();
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    // A disabled channel must not throw: throwing would retry into the DLQ for a deliberate skip.
    expect(deps.log).toHaveBeenCalledWith("notification_skipped_disabled", {
      messageType: "optin_welcome",
    });
  });

  it("THROWS on a config read failure (infra error -> retry -> DLQ)", async () => {
    deps.config.get.mockRejectedValue(new Error("dynamo down"));
    await expect(sendNotification(deps, request)).rejects.toThrow("dynamo down");
  });

  it("THROWS on a send failure (unlike the outbox era there is no markFailed swallow)", async () => {
    deps.whatsapp.sendTemplate.mockRejectedValue(new Error("template not approved"));
    await expect(sendNotification(deps, request)).rejects.toThrow("template not approved");
    expect(deps.log).not.toHaveBeenCalledWith("notification_sent", expect.anything());
  });
});
