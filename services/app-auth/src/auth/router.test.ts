import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fakes so the vi.mock factories can close over them (vitest hoists vi.mock above imports).
const { fake } = vi.hoisted(() => ({
  fake: {
    region: "il-central-1",
    config: { get: vi.fn() },
    velocity: { hit: vi.fn() },
    cognito: {
      getUserByPhone: vi.fn(),
      createUser: vi.fn(),
      updateAttributes: vi.fn(),
      startSmsOtp: vi.fn(),
      respondSmsOtp: vi.fn(),
      refresh: vi.fn(),
      revoke: vi.fn(),
      startWebAuthnRegistration: vi.fn(),
      completeWebAuthnRegistration: vi.fn(),
    },
    challenges: {
      putChallenge: vi.fn(),
      getChallenge: vi.fn(),
      deleteChallenge: vi.fn(),
    },
    guests: { claim: vi.fn() },
    tickets: { sign: vi.fn(), verify: vi.fn() },
  },
}));

vi.mock("../context", () => ({ getContext: () => fake }));

// Chain-logging assertions (otp_start / otp_resend / otp_send_failed) — one shared instance.
const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@aws-lambda-powertools/logger", () => ({ Logger: vi.fn(() => logMock) }));

import { authRouter } from "./router";

const app = new Hono();
app.route("/auth", authRouter());

const PHONE = "+972541234567";
const SUB = "11111111-1111-1111-1111-111111111111";

const cognitoResult = { AccessToken: "a", IdToken: "i", RefreshToken: "r", ExpiresIn: 3600 };

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The order of a mock's first invocation — throws if it was never called (test bug, not a real case). */
function firstCallOrder(mock: { mock: { invocationCallOrder: number[] } }): number {
  const order = mock.mock.invocationCallOrder[0];
  if (order === undefined) throw new Error("mock was never called");
  return order;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.config.get.mockImplementation((key: string) => {
    switch (key) {
      case "auth.smsEnabled":
        return Promise.resolve(true);
      case "auth.whatsappEnabled":
        return Promise.resolve(true);
      case "auth.defaultOtpChannel":
        return Promise.resolve("whatsapp");
      case "whatsapp.phoneNumberId":
        return Promise.resolve("phone-number-id-test");
      case "auth.smsMaxPerWindow":
        return Promise.resolve(5);
      case "auth.smsLockoutMinutes":
        return Promise.resolve(180);
      default:
        return Promise.resolve(undefined);
    }
  });
  fake.velocity.hit.mockResolvedValue({ count: 1, ttl: 0 }); // within limit
});

describe("POST /auth/start", () => {
  it("creates a new user and stores a challenge", async () => {
    fake.cognito.getUserByPhone.mockResolvedValue(null);
    fake.cognito.createUser.mockResolvedValue({ username: "u", sub: SUB });
    fake.cognito.startSmsOtp.mockResolvedValue({ session: "sess" });

    const res = await post("/auth/start", { phone: PHONE, channel: "sms" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resendAfterSec: 30, expiresInSec: 180 });
    expect(fake.cognito.createUser).toHaveBeenCalledWith(PHONE);
    expect(fake.challenges.putChallenge).toHaveBeenCalledOnce();
  });

  it("429s when over the velocity limit", async () => {
    fake.velocity.hit.mockResolvedValue({ count: 99, ttl: 1000 });
    const res = await post("/auth/start", { phone: PHONE, channel: "sms" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(fake.cognito.getUserByPhone).not.toHaveBeenCalled();
  });

  it("400s on an invalid phone", async () => {
    const res = await post("/auth/start", { phone: "not-a-phone", channel: "sms" });
    expect(res.status).toBe(400);
  });
});

describe("GET /auth/config", () => {
  it("projects the enabled channels and the preselect", async () => {
    const res = await app.request("/auth/config");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ channels: ["whatsapp", "sms"], defaultChannel: "whatsapp" });
  });

  it("omits whatsapp when the switch is on but the phoneNumberId is unset", async () => {
    fake.config.get.mockImplementation((key: string) =>
      Promise.resolve(
        {
          "auth.smsEnabled": true,
          "auth.whatsappEnabled": true,
          "whatsapp.phoneNumberId": "",
          "auth.defaultOtpChannel": "whatsapp",
        }[key],
      ),
    );
    expect(await (await app.request("/auth/config")).json()).toEqual({
      channels: ["sms"],
      defaultChannel: "sms",
    });
  });

  it("returns an empty projection when everything is off", async () => {
    fake.config.get.mockResolvedValue(false);
    expect(await (await app.request("/auth/config")).json()).toEqual({
      channels: [],
      defaultChannel: null,
    });
  });
});

describe("POST /auth/start — channel handling (ADR-0023)", () => {
  beforeEach(() => {
    fake.cognito.getUserByPhone.mockResolvedValue({ username: "u", sub: SUB });
    fake.cognito.startSmsOtp.mockResolvedValue({ session: "sess" });
  });

  it("400s when channel is missing — no server-side default", async () => {
    expect((await post("/auth/start", { phone: PHONE })).status).toBe(400);
  });

  it("writes custom:otpChannel (+ locale) BEFORE initiating, stores requestedChannel, echoes channel", async () => {
    const res = await post("/auth/start", { phone: PHONE, channel: "whatsapp", locale: "he" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ channel: "whatsapp" });
    expect(fake.cognito.updateAttributes).toHaveBeenCalledWith("u", [
      { Name: "custom:otpChannel", Value: "whatsapp" },
      { Name: "locale", Value: "he" },
    ]);
    // Attribute write happens before the initiate that triggers the sender.
    expect(firstCallOrder(fake.cognito.updateAttributes)).toBeLessThan(
      firstCallOrder(fake.cognito.startSmsOtp),
    );
    expect(fake.challenges.putChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ requestedChannel: "whatsapp" }),
    );
    // Chain log: sub correlates with message-sender's otp_delivered line.
    expect(logMock.info).toHaveBeenCalledWith("otp_start", {
      challengeId: expect.any(String),
      channel: "whatsapp",
      sub: SUB,
    });
  });

  it("503s channel_disabled for a requested-but-unavailable channel — no silent switch", async () => {
    fake.config.get.mockImplementation((key: string) =>
      Promise.resolve(
        {
          "auth.smsEnabled": true,
          "auth.whatsappEnabled": false,
          "whatsapp.phoneNumberId": "",
          "auth.defaultOtpChannel": "whatsapp",
          "auth.smsMaxPerWindow": 5,
          "auth.smsLockoutMinutes": 180,
        }[key],
      ),
    );
    const res = await post("/auth/start", { phone: PHONE, channel: "whatsapp" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "channel_disabled", channel: "whatsapp" });
    expect(fake.cognito.startSmsOtp).not.toHaveBeenCalled();
  });

  it("503s channel_disabled for sms when the SMS switch is off", async () => {
    fake.config.get.mockImplementation((key: string) =>
      Promise.resolve(
        {
          "auth.smsEnabled": false,
          "auth.whatsappEnabled": true,
          "whatsapp.phoneNumberId": "phone-number-id-test",
          "auth.defaultOtpChannel": "whatsapp",
          "auth.smsMaxPerWindow": 5,
          "auth.smsLockoutMinutes": 180,
        }[key],
      ),
    );
    const res = await post("/auth/start", { phone: PHONE, channel: "sms" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "channel_disabled", channel: "sms" });
  });

  it("502s send_failed when the custom sender throws inside AdminInitiateAuth", async () => {
    fake.cognito.startSmsOtp.mockRejectedValue(
      Object.assign(new Error("sender blew up"), { name: "UnexpectedLambdaException" }),
    );
    const res = await post("/auth/start", { phone: PHONE, channel: "whatsapp" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "send_failed", channel: "whatsapp" });
    expect(fake.challenges.putChallenge).not.toHaveBeenCalled(); // no half-created challenge
    expect(logMock.warn).toHaveBeenCalledWith("otp_send_failed", {
      channel: "whatsapp",
      sub: SUB,
      error: "UnexpectedLambdaException",
    });
  });
});

describe("POST /auth/verify", () => {
  const challenge = {
    challengeId: "c1",
    username: "u",
    sub: SUB,
    phone: PHONE,
    cognitoSession: "sess",
    isNewUser: false,
    resendAfterEpoch: 0,
    attempts: 0,
    ttl: 0,
  };

  it("issues a signed self-contained ticket on OTP success (no Aurora on the edge)", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.cognito.respondSmsOtp.mockResolvedValue({ kind: "tokens", result: cognitoResult });
    fake.tickets.sign.mockResolvedValue("signed-ticket");

    const res = await post("/auth/verify", { challengeId: "c1", code: "12345678" });
    expect(res.status).toBe(200);
    // Edge only hands off the ticket; /auth/session (app-core) resolves login vs register.
    expect(await res.json()).toEqual({ registrationTicket: "signed-ticket" });
    // The ticket carries the identity + tokens, so nothing is parked server-side.
    expect(fake.tickets.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sub: SUB, phone: PHONE, accessToken: "a", refreshToken: "r" }),
    );
    expect(fake.challenges.deleteChallenge).toHaveBeenCalledWith("c1");
  });

  it("401s on a wrong code and counts the attempt", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.cognito.respondSmsOtp.mockRejectedValue(
      Object.assign(new Error("bad"), { name: "CodeMismatchException" }),
    );
    const res = await post("/auth/verify", { challengeId: "c1", code: "00000000" });
    expect(res.status).toBe(401);
    expect(fake.challenges.putChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1 }),
    );
  });

  it("retries a wrong code on the same challengeId, then succeeds", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    // First answer is wrong: Cognito re-issues the challenge with a fresh session.
    fake.cognito.respondSmsOtp.mockResolvedValueOnce({ kind: "retry", session: "sess2" });

    const bad = await post("/auth/verify", { challengeId: "c1", code: "00000000" });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "invalid_code" });
    // The new session is persisted under the SAME challengeId; it is not deleted.
    expect(fake.challenges.putChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ challengeId: "c1", cognitoSession: "sess2", attempts: 1 }),
    );
    expect(fake.challenges.deleteChallenge).not.toHaveBeenCalled();

    // Second answer is correct on the same challengeId.
    fake.cognito.respondSmsOtp.mockResolvedValueOnce({ kind: "tokens", result: cognitoResult });
    fake.tickets.sign.mockResolvedValue("signed-ticket");

    const ok = await post("/auth/verify", { challengeId: "c1", code: "12345678" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { registrationTicket: string }).registrationTicket).toBeTruthy();
    expect(fake.challenges.deleteChallenge).toHaveBeenCalledWith("c1");
  });
});

describe("POST /auth/resend", () => {
  const challenge = {
    challengeId: "c1",
    username: "u",
    sub: SUB,
    phone: PHONE,
    cognitoSession: "sess",
    isNewUser: false,
    resendAfterEpoch: 0,
    attempts: 0,
    ttl: 0,
  };

  it("re-issues the OTP when within the velocity limit", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.cognito.startSmsOtp.mockResolvedValue({ session: "sess2" });

    const res = await post("/auth/resend", { challengeId: "c1", channel: "sms" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resendAfterSec: 30, expiresInSec: 180 });
    expect(fake.cognito.startSmsOtp).toHaveBeenCalledOnce();
  });

  it("429s and does not resend once the phone trips the velocity cap", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.velocity.hit.mockResolvedValue({ count: 6, ttl: 9999999999 });

    const res = await post("/auth/resend", { challengeId: "c1", channel: "sms" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfterSec: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(fake.cognito.startSmsOtp).not.toHaveBeenCalled();
  });
});

describe("POST /auth/resend — channel switch (ADR-0023)", () => {
  const challenge = {
    challengeId: "c1",
    username: "u",
    sub: SUB,
    phone: PHONE,
    cognitoSession: "sess",
    isNewUser: false,
    requestedChannel: "whatsapp",
    resendAfterEpoch: 0,
    attempts: 0,
    ttl: 0,
  };

  it("re-sends via the explicitly requested channel (the UI's send-via-SMS path)", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.cognito.startSmsOtp.mockResolvedValue({ session: "sess2" });
    const res = await post("/auth/resend", { challengeId: "c1", channel: "sms" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ channel: "sms" });
    expect(fake.cognito.updateAttributes).toHaveBeenCalledWith("u", [
      { Name: "custom:otpChannel", Value: "sms" },
    ]);
    expect(fake.challenges.putChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ requestedChannel: "sms", cognitoSession: "sess2" }),
    );
    expect(logMock.info).toHaveBeenCalledWith("otp_resend", {
      challengeId: "c1",
      channel: "sms",
      sub: SUB,
    });
  });

  it("503s channel_disabled on resend too", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.config.get.mockImplementation((key: string) =>
      Promise.resolve(
        {
          "auth.smsEnabled": false,
          "auth.whatsappEnabled": true,
          "whatsapp.phoneNumberId": "phone-number-id-test",
          "auth.defaultOtpChannel": "whatsapp",
          "auth.smsMaxPerWindow": 5,
          "auth.smsLockoutMinutes": 180,
        }[key],
      ),
    );
    const res = await post("/auth/resend", { challengeId: "c1", channel: "sms" });
    expect(res.status).toBe(503);
  });
});

describe("passkey registration", () => {
  const credential = {
    id: "cred-1",
    rawId: "cred-1",
    type: "public-key",
    response: { clientDataJSON: "x", attestationObject: "y" },
  };

  function postAuthed(path: string, body: unknown) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer access-token" },
      body: JSON.stringify(body),
    });
  }

  it("options requires a Bearer token", async () => {
    const res = await post("/auth/passkey/register/options", {});
    expect(res.status).toBe(401);
  });

  it("returns server-generated creation options", async () => {
    fake.cognito.startWebAuthnRegistration.mockResolvedValue({ challenge: "abc" });
    const res = await postAuthed("/auth/passkey/register/options", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ options: { challenge: "abc" } });
    expect(fake.cognito.startWebAuthnRegistration).toHaveBeenCalledWith("access-token");
  });

  it("verify registers the credential and echoes the passkey", async () => {
    fake.cognito.completeWebAuthnRegistration.mockResolvedValue(undefined);
    const res = await postAuthed("/auth/passkey/register/verify", { credential });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { passkey: { credentialId: string } };
    expect(body.passkey.credentialId).toBe("cred-1");
    expect(fake.cognito.completeWebAuthnRegistration).toHaveBeenCalledWith(
      "access-token",
      credential,
    );
  });
});
