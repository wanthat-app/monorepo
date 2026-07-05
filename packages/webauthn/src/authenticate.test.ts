import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks so vi.mock factories (hoisted above imports) can close over them.
const { generateAuthenticationOptionsMock, verifyAuthenticationResponseMock } = vi.hoisted(() => ({
  generateAuthenticationOptionsMock: vi.fn(),
  verifyAuthenticationResponseMock: vi.fn(),
}));

vi.mock("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: generateAuthenticationOptionsMock,
  verifyAuthenticationResponse: verifyAuthenticationResponseMock,
}));

import { buildAuthenticationOptions, verifyAuthentication } from "./authenticate";
import type { StoredCredential } from "./register";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildAuthenticationOptions", () => {
  it("builds userless options: empty allowCredentials, UV required", async () => {
    generateAuthenticationOptionsMock.mockResolvedValue({ challenge: "chal" });

    await buildAuthenticationOptions({ rpID: "wanthat.app" });

    expect(generateAuthenticationOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: "wanthat.app",
        allowCredentials: [],
        userVerification: "required",
      }),
    );
  });
});

describe("verifyAuthentication", () => {
  const storedCredential: StoredCredential = {
    credentialId: "cid",
    publicKey: Buffer.from([1, 2, 3]).toString("base64url"),
    counter: 4,
    transports: ["internal"],
  };

  const baseArgs = {
    response: {} as never,
    expectedChallenge: "chal",
    expectedOrigin: "https://wanthat.app",
    expectedRPID: "wanthat.app",
    credential: storedCredential,
  };

  it("returns the new counter on success and decodes the stored public key", async () => {
    verifyAuthenticationResponseMock.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    });

    const result = await verifyAuthentication(baseArgs);

    expect(result).toEqual({ newCounter: 5 });
    const call = verifyAuthenticationResponseMock.mock.calls[0]?.[0];
    expect(call.credential.publicKey).toBeInstanceOf(Uint8Array);
    expect(Array.from(call.credential.publicKey)).toEqual([1, 2, 3]);
    expect(call.requireUserVerification).toBe(true);
  });

  it("rejects when not verified", async () => {
    verifyAuthenticationResponseMock.mockResolvedValue({ verified: false });

    await expect(verifyAuthentication(baseArgs)).rejects.toThrow(/not verified/);
  });
});
