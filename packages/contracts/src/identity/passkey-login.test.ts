import { describe, expect, it } from "vitest";
import { PasskeyLoginOptionsBody, PasskeyLoginVerifyBody } from "./auth";

describe("passkey login contracts (ADR-0022 Flow B)", () => {
  it("options body requires a valid phone (the device-remembered username)", () => {
    expect(PasskeyLoginOptionsBody.safeParse({ phone: "+972541234567" }).success).toBe(true);
    expect(PasskeyLoginOptionsBody.safeParse({ phone: "nope" }).success).toBe(false);
    expect(PasskeyLoginOptionsBody.safeParse({}).success).toBe(false);
  });
  it("verify body requires a challengeId and a well-formed assertion", () => {
    expect(PasskeyLoginVerifyBody.safeParse({ challengeId: "c1" }).success).toBe(false);
    const cred = {
      id: "x",
      rawId: "x",
      type: "public-key",
      response: { clientDataJSON: "a", authenticatorData: "b", signature: "c" },
    };
    expect(PasskeyLoginVerifyBody.safeParse({ challengeId: "c1", credential: cred }).success).toBe(
      true,
    );
  });
});
