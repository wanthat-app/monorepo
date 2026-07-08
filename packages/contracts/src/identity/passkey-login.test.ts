import { describe, expect, it } from "vitest";
import {
  PasskeyLoginChallengeResponse,
  PasskeyLoginVerifyBody,
  PasskeyRegisterOptionsResponse,
  PasskeyRegisterVerifyBody,
} from "./auth";

describe("passkey login/register contracts (ADR-0006 — userless discoverable)", () => {
  it("login challenge response carries a challengeId + options (no username)", () => {
    const ok = PasskeyLoginChallengeResponse.safeParse({
      challengeId: "c1",
      options: { challenge: "abc" },
    });
    expect(ok.success).toBe(true);
    expect(PasskeyLoginChallengeResponse.safeParse({ options: { challenge: "abc" } }).success).toBe(
      false,
    );
  });

  it("login verify body requires a challengeId and a well-formed assertion", () => {
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

  it("register options response + verify body carry the challengeId (server-issued challenge)", () => {
    expect(
      PasskeyRegisterOptionsResponse.safeParse({ challengeId: "c1", options: { challenge: "abc" } })
        .success,
    ).toBe(true);
    const cred = {
      id: "x",
      rawId: "x",
      type: "public-key",
      response: { clientDataJSON: "a", attestationObject: "o" },
    };
    expect(
      PasskeyRegisterVerifyBody.safeParse({ challengeId: "c1", credential: cred }).success,
    ).toBe(true);
    expect(PasskeyRegisterVerifyBody.safeParse({ credential: cred }).success).toBe(false);
  });
});
