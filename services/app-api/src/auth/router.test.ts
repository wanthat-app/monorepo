import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fakes so the vi.mock factories can close over them (vitest hoists vi.mock above imports).
const { fake, dbMock } = vi.hoisted(() => ({
  fake: {
    region: "il-central-1",
    db: {},
    config: { get: vi.fn() },
    velocity: { hit: vi.fn() },
    cognito: {
      getUserByPhone: vi.fn(),
      createUser: vi.fn(),
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
      putTicket: vi.fn(),
      getTicket: vi.fn(),
      deleteTicket: vi.fn(),
    },
    guests: { claim: vi.fn() },
    tickets: { sign: vi.fn(), verify: vi.fn() },
  },
  dbMock: { findByCognitoSub: vi.fn(), insertCustomer: vi.fn() },
}));

vi.mock("../context", () => ({ getContext: () => fake }));
vi.mock("@wanthat/db", () => dbMock);

import { authRouter } from "./router";

const app = new Hono();
app.route("/auth", authRouter());

const PHONE = "+972541234567";
const SUB = "11111111-1111-1111-1111-111111111111";

const customer = {
  id: "22222222-2222-2222-2222-222222222222",
  phone: PHONE,
  email: null,
  firstName: "Dana",
  lastName: "Levi",
  locale: "he-IL",
  status: "active",
  createdAt: "2026-06-29T00:00:00.000Z",
  updatedAt: "2026-06-29T00:00:00.000Z",
};

const cognitoResult = { AccessToken: "a", IdToken: "i", RefreshToken: "r", ExpiresIn: 3600 };

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Per-key runtime config: SMS enabled, cap 5 sends per 180-minute window.
  fake.config.get.mockImplementation((key: string) => {
    switch (key) {
      case "auth.smsEnabled":
        return Promise.resolve(true);
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

    const res = await post("/auth/start", { phone: PHONE });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resendAfterSec: 30, expiresInSec: 180 });
    expect(fake.cognito.createUser).toHaveBeenCalledWith(PHONE);
    expect(fake.challenges.putChallenge).toHaveBeenCalledOnce();
  });

  it("503s when the SMS kill switch is off", async () => {
    fake.config.get.mockResolvedValue(false);
    const res = await post("/auth/start", { phone: PHONE });
    expect(res.status).toBe(503);
    expect(fake.cognito.startSmsOtp).not.toHaveBeenCalled();
  });

  it("429s when over the velocity limit", async () => {
    fake.velocity.hit.mockResolvedValue({ count: 99, ttl: 1000 });
    const res = await post("/auth/start", { phone: PHONE });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(fake.cognito.getUserByPhone).not.toHaveBeenCalled();
  });

  it("400s on an invalid phone", async () => {
    const res = await post("/auth/start", { phone: "not-a-phone" });
    expect(res.status).toBe(400);
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

  it("returns authenticated when a customer exists", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.cognito.respondSmsOtp.mockResolvedValue({ kind: "tokens", result: cognitoResult });
    dbMock.findByCognitoSub.mockResolvedValue(customer);

    const res = await post("/auth/verify", { challengeId: "c1", code: "123456" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; tokens: { accessToken: string } };
    expect(body.status).toBe("authenticated");
    expect(body.tokens.accessToken).toBe("a");
    expect(fake.challenges.deleteChallenge).toHaveBeenCalledWith("c1");
  });

  it("returns registration_required and parks tokens when no customer exists", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.cognito.respondSmsOtp.mockResolvedValue({ kind: "tokens", result: cognitoResult });
    dbMock.findByCognitoSub.mockResolvedValue(undefined);
    fake.tickets.sign.mockResolvedValue("signed-ticket");

    const res = await post("/auth/verify", { challengeId: "c1", code: "123456" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "registration_required", registrationTicket: "signed-ticket" });
    expect(fake.challenges.putTicket).toHaveBeenCalledOnce();
  });

  it("401s on a wrong code and counts the attempt", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.cognito.respondSmsOtp.mockRejectedValue(
      Object.assign(new Error("bad"), { name: "CodeMismatchException" }),
    );
    const res = await post("/auth/verify", { challengeId: "c1", code: "000000" });
    expect(res.status).toBe(401);
    expect(fake.challenges.putChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1 }),
    );
  });

  it("retries a wrong code on the same challengeId, then succeeds", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    // First answer is wrong: Cognito re-issues the challenge with a fresh session.
    fake.cognito.respondSmsOtp.mockResolvedValueOnce({ kind: "retry", session: "sess2" });

    const bad = await post("/auth/verify", { challengeId: "c1", code: "000000" });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "invalid_code" });
    // The new session is persisted under the SAME challengeId; it is not deleted.
    expect(fake.challenges.putChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ challengeId: "c1", cognitoSession: "sess2", attempts: 1 }),
    );
    expect(fake.challenges.deleteChallenge).not.toHaveBeenCalled();

    // Second answer is correct on the same challengeId.
    fake.cognito.respondSmsOtp.mockResolvedValueOnce({ kind: "tokens", result: cognitoResult });
    dbMock.findByCognitoSub.mockResolvedValue(customer);

    const ok = await post("/auth/verify", { challengeId: "c1", code: "123456" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("authenticated");
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

    const res = await post("/auth/resend", { challengeId: "c1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resendAfterSec: 30, expiresInSec: 180 });
    expect(fake.cognito.startSmsOtp).toHaveBeenCalledOnce();
  });

  it("429s and does not resend once the phone trips the velocity cap", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.velocity.hit.mockResolvedValue({ count: 6, ttl: 9999999999 });

    const res = await post("/auth/resend", { challengeId: "c1" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfterSec: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(fake.cognito.startSmsOtp).not.toHaveBeenCalled();
  });
});

describe("POST /auth/register", () => {
  it("provisions the customer and returns a session", async () => {
    fake.tickets.verify.mockResolvedValue("tkt1");
    fake.challenges.getTicket.mockResolvedValue({
      ticketId: "tkt1",
      sub: SUB,
      phone: PHONE,
      accessToken: "a",
      idToken: "i",
      refreshToken: "r",
      expiresIn: 3600,
      ttl: 0,
    });
    dbMock.insertCustomer.mockResolvedValue(customer);

    const res = await post("/auth/register", {
      registrationTicket: "tkt1.mac",
      firstName: "Dana",
      lastName: "Levi",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customer: { firstName: string } };
    expect(body.customer.firstName).toBe("Dana");
    expect(dbMock.insertCustomer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cognitoSub: SUB, phone: PHONE, locale: "he-IL" }),
    );
    expect(fake.challenges.deleteTicket).toHaveBeenCalledWith("tkt1");
  });

  it("401s on a forged ticket", async () => {
    fake.tickets.verify.mockResolvedValue(null);
    const res = await post("/auth/register", {
      registrationTicket: "bad",
      firstName: "A",
      lastName: "B",
    });
    expect(res.status).toBe(401);
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
