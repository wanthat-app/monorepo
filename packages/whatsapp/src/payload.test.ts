import { describe, expect, it } from "vitest";
import { buildTemplateMessage } from "./payload";

describe("buildTemplateMessage", () => {
  it("builds the otp_code authentication template (body + copy-code button params)", () => {
    const msg = buildTemplateMessage({
      type: "otp_code",
      language: "he",
      variables: { code: "12345678" },
      to: "+972541234567",
    });
    expect(msg).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+972541234567",
      type: "template",
      template: {
        name: "otp_code",
        language: { code: "he" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "12345678" }] },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "12345678" }],
          },
        ],
      },
    });
  });

  it("throws on invalid variables — no fallback (spec rev 2)", () => {
    expect(() =>
      buildTemplateMessage({ type: "otp_code", language: "en", variables: {}, to: "+97250" }),
    ).toThrow();
    expect(() =>
      buildTemplateMessage({
        type: "otp_code",
        language: "en",
        variables: { code: "123", extra: "x" },
        to: "+97250",
      }),
    ).toThrow();
  });

  it("throws on an unknown message type", () => {
    expect(() =>
      buildTemplateMessage({
        // @ts-expect-error deliberately outside the registry
        type: "nope",
        language: "en",
        variables: {},
        to: "+97250",
      }),
    ).toThrow(/unknown message type/);
  });
});
