import { describe, expect, it, vi } from "vitest";
import { META_API_VERSION, WhatsAppSender } from "./client";

describe("WhatsAppSender", () => {
  it("submits the built payload through SendWhatsAppMessage", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "wamid.X" });
    // Structural stand-in for SocialMessagingClient — the sender only calls .send().
    const sender = new WhatsAppSender({ send } as never);

    const res = await sender.sendTemplate({
      phoneNumberId: "phone-number-id-test",
      type: "otp_code",
      language: "en",
      variables: { code: "12345678" },
      to: "+972541234567",
    });

    expect(res).toEqual({ messageId: "wamid.X" });
    const call = send.mock.calls[0];
    if (!call) throw new Error("expected send to have been called");
    const [request] = call;
    if (!request) throw new Error("expected send to have been called with an argument");
    const input = request.input;
    expect(input.originationPhoneNumberId).toBe("phone-number-id-test");
    expect(input.metaApiVersion).toBe(META_API_VERSION);
    const body = JSON.parse(new TextDecoder().decode(input.message));
    expect(body.template.name).toBe("otp_code");
    expect(body.to).toBe("+972541234567");
  });

  it("propagates submission errors — the caller decides what a failure means", async () => {
    const send = vi.fn().mockRejectedValue(new Error("ThrottledRequestException"));
    const sender = new WhatsAppSender({ send } as never);
    await expect(
      sender.sendTemplate({
        phoneNumberId: "phone-number-id-test",
        type: "otp_code",
        language: "en",
        variables: { code: "12345678" },
        to: "+972541234567",
      }),
    ).rejects.toThrow("ThrottledRequestException");
  });
});
