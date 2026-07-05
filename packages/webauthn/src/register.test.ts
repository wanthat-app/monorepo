import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks so vi.mock factories (hoisted above imports) can close over them.
const { generateRegistrationOptionsMock, verifyRegistrationResponseMock } = vi.hoisted(() => ({
  generateRegistrationOptionsMock: vi.fn(),
  verifyRegistrationResponseMock: vi.fn(),
}));

vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: generateRegistrationOptionsMock,
  verifyRegistrationResponse: verifyRegistrationResponseMock,
}));

import { buildRegistrationOptions, verifyRegistration } from "./register";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildRegistrationOptions", () => {
  it("requires a resident key, user verification, and a platform authenticator", async () => {
    generateRegistrationOptionsMock.mockResolvedValue({ challenge: "chal" });

    await buildRegistrationOptions({
      rpID: "wanthat.app",
      rpName: "Wanthat",
      sub: "sub-123",
      userName: "+972541234567",
      displayName: "Dana",
    });

    expect(generateRegistrationOptionsMock).toHaveBeenCalledTimes(1);
    const call = generateRegistrationOptionsMock.mock.calls[0]?.[0];
    expect(call.authenticatorSelection).toEqual({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
      authenticatorAttachment: "platform",
    });
    expect(call.attestationType).toBe("none");
    // userID must decode back to the sub we passed in.
    expect(new TextDecoder().decode(call.userID)).toBe("sub-123");
  });

  it("maps excludeCredentialIds to excludeCredentials entries", async () => {
    generateRegistrationOptionsMock.mockResolvedValue({ challenge: "chal" });

    await buildRegistrationOptions({
      rpID: "wanthat.app",
      rpName: "Wanthat",
      sub: "sub-123",
      userName: "+972541234567",
      displayName: "Dana",
      excludeCredentialIds: ["cred-a", "cred-b"],
    });

    const call = generateRegistrationOptionsMock.mock.calls[0]?.[0];
    expect(call.excludeCredentials).toEqual([{ id: "cred-a" }, { id: "cred-b" }]);
  });
});

describe("verifyRegistration", () => {
  const baseArgs = {
    response: {} as never,
    expectedChallenge: "chal",
    expectedOrigin: "https://wanthat.app",
    expectedRPID: "wanthat.app",
  };

  it("returns the storable credential on success", async () => {
    verifyRegistrationResponseMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "cid",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ["internal"],
        },
      },
    });

    const result = await verifyRegistration(baseArgs);

    expect(result).toEqual({
      credentialId: "cid",
      publicKey: Buffer.from([1, 2, 3]).toString("base64url"),
      counter: 0,
      transports: ["internal"],
    });
    expect(verifyRegistrationResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({ requireUserVerification: true }),
    );
  });

  it("rejects when not verified", async () => {
    verifyRegistrationResponseMock.mockResolvedValue({ verified: false });

    await expect(verifyRegistration(baseArgs)).rejects.toThrow(/not verified/);
  });
});
