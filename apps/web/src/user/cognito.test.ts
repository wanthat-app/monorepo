import { afterEach, describe, expect, it, vi } from "vitest";
import { CognitoError, confirmSignUp, initiateUserAuth, refreshTokens, signUp } from "./cognito";

// Pin the runtime config so request shaping is deterministic (no /config.json in tests).
vi.mock("../lib/config", () => ({
  getConfig: () => ({ cognitoRegion: "il-central-1", userPoolClientId: "client-123" }),
}));

afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown) => ({ ok: true, json: async () => body });
const fail = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [
    string,
    { method: string; headers: Record<string, string>; body: string },
  ];
  return { url, init, body: JSON.parse(init.body) as Record<string, unknown> };
}

describe("cognito client — request shaping", () => {
  it("POSTs the operation to the regional endpoint with the amz-json-1.1 target headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ UserSub: "s-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await signUp({ phone: "+972541234567", attributes: { phone_number: "+972541234567" } });

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe("https://cognito-idp.il-central-1.amazonaws.com/");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/x-amz-json-1.1");
    expect(init.headers["x-amz-target"]).toBe("AWSCognitoIdentityProviderService.SignUp");
  });

  it("SignUp carries the profile as a UserAttributes list (incl. custom:otpChannel) + guestId metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ UserSub: "s-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await signUp({
      phone: "+972541234567",
      attributes: {
        phone_number: "+972541234567",
        given_name: "דנה",
        family_name: "לוי",
        locale: "he-IL",
        "custom:otpChannel": "whatsapp",
      },
      clientMetadata: { guestId: "g-42" },
    });

    const { body } = lastCall(fetchMock);
    expect(body.ClientId).toBe("client-123");
    expect(body.Username).toBe("+972541234567");
    expect(body.UserAttributes).toContainEqual({ Name: "custom:otpChannel", Value: "whatsapp" });
    expect(body.UserAttributes).toContainEqual({ Name: "given_name", Value: "דנה" });
    expect(body.ClientMetadata).toEqual({ guestId: "g-42" });
  });

  it("ConfirmSignUp carries the guestId ClientMetadata — Cognito forwards THIS call's metadata to Post-Confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ Session: "sess-2" }));
    vi.stubGlobal("fetch", fetchMock);

    await confirmSignUp({
      phone: "+972541234567",
      code: "123456",
      session: "sess-1",
      clientMetadata: { guestId: "g-42" },
    });

    const { init, body } = lastCall(fetchMock);
    expect(init.headers["x-amz-target"]).toBe("AWSCognitoIdentityProviderService.ConfirmSignUp");
    expect(body.ConfirmationCode).toBe("123456");
    expect(body.Session).toBe("sess-1");
    expect(body.ClientMetadata).toEqual({ guestId: "g-42" });
  });

  it("InitiateAuth(USER_AUTH) sends USERNAME + PREFERRED_CHALLENGE", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(ok({ ChallengeName: "SMS_OTP", Session: "sess-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await initiateUserAuth({ phone: "+972541234567", preferredChallenge: "SMS_OTP" });

    expect(res.ChallengeName).toBe("SMS_OTP");
    const { body } = lastCall(fetchMock);
    expect(body.AuthFlow).toBe("USER_AUTH");
    expect(body.AuthParameters).toEqual({
      USERNAME: "+972541234567",
      PREFERRED_CHALLENGE: "SMS_OTP",
    });
  });

  it("refresh rides InitiateAuth(REFRESH_TOKEN_AUTH)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ AuthenticationResult: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await refreshTokens("rt-1");

    const { body } = lastCall(fetchMock);
    expect(body.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
    expect(body.AuthParameters).toEqual({ REFRESH_TOKEN: "rt-1" });
  });
});

describe("cognito client — error mapping", () => {
  it("maps UserNotFoundException to the user_not_found code (the sign-in vs sign-up branch)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          fail(400, { __type: "UserNotFoundException", message: "User does not exist." }),
        ),
    );

    const pending = initiateUserAuth({ phone: "+972541234567" });
    await expect(pending).rejects.toBeInstanceOf(CognitoError);
    await expect(pending).rejects.toMatchObject({
      code: "user_not_found",
      name: "UserNotFoundException",
      status: 400,
      message: "User does not exist.",
    });
  });

  it("strips a namespace-qualified __type before mapping", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          fail(400, { __type: "com.amazonaws.cognito#CodeMismatchException", message: "bad code" }),
        ),
    );

    await expect(confirmSignUp({ phone: "+972", code: "0" })).rejects.toMatchObject({
      name: "CodeMismatchException",
      code: "invalid_code",
    });
  });

  it("maps throttling to rate_limited and unknown exceptions to generic", async () => {
    const respond = (type: string) =>
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(400, { __type: type })));

    respond("TooManyRequestsException");
    await expect(initiateUserAuth({ phone: "+972" })).rejects.toMatchObject({
      code: "rate_limited",
    });

    respond("SomethingBrandNewException");
    await expect(initiateUserAuth({ phone: "+972" })).rejects.toMatchObject({ code: "generic" });
  });

  it("survives a non-JSON error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json");
        },
      }),
    );

    const pending = initiateUserAuth({ phone: "+972" });
    await expect(pending).rejects.toBeInstanceOf(CognitoError);
    await expect(pending).rejects.toMatchObject({ code: "generic", status: 500 });
  });
});
