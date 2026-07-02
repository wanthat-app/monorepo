import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fakes so the vi.mock factories can close over them (vitest hoists vi.mock above imports).
const { fake, dbMock } = vi.hoisted(() => ({
  fake: {
    region: "il-central-1",
    db: {},
    guests: { claim: vi.fn() },
    tickets: { sign: vi.fn(), verify: vi.fn() },
    appUrl: "https://dev.wanthat.app",
    outbox: { put: vi.fn() },
  },
  dbMock: { findByCognitoSub: vi.fn(), insertCustomer: vi.fn() },
}));

vi.mock("../context", () => ({ getContext: () => fake }));
vi.mock("@wanthat/db", () => dbMock);

// Chain-logging assertions (optin_welcome_enqueued / _enqueue_failed) — one shared instance.
const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@aws-lambda-powertools/logger", () => ({ Logger: vi.fn(() => logMock) }));

import { authRouter } from "./register";

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

const ticket = {
  sub: SUB,
  phone: PHONE,
  accessToken: "a",
  idToken: "i",
  refreshToken: "r",
  expiresIn: 3600,
  exp: 9999999999,
};

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /auth/session", () => {
  it("resolves an existing customer to an authenticated session", async () => {
    fake.tickets.verify.mockResolvedValue(ticket);
    dbMock.findByCognitoSub.mockResolvedValue(customer);

    const res = await post("/auth/session", { registrationTicket: "payload.mac" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; customer?: { id: string } };
    expect(body.status).toBe("authenticated");
    expect(body.customer?.id).toBe(customer.id);
    expect(dbMock.insertCustomer).not.toHaveBeenCalled();
  });

  it("returns registration_required (with the ticket) when no customer exists", async () => {
    fake.tickets.verify.mockResolvedValue(ticket);
    dbMock.findByCognitoSub.mockResolvedValue(undefined);

    const res = await post("/auth/session", { registrationTicket: "payload.mac" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "registration_required",
      registrationTicket: "payload.mac",
    });
  });

  it("401s on a forged or expired ticket", async () => {
    fake.tickets.verify.mockResolvedValue(null);
    const res = await post("/auth/session", { registrationTicket: "bad" });
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/register", () => {
  it("provisions the customer from the ticket and returns a session", async () => {
    fake.tickets.verify.mockResolvedValue(ticket);
    dbMock.findByCognitoSub.mockResolvedValue(undefined);
    dbMock.insertCustomer.mockResolvedValue(customer);

    const res = await post("/auth/register", {
      registrationTicket: "payload.mac",
      firstName: "Dana",
      lastName: "Levi",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      customer: { firstName: string };
      tokens: { accessToken: string };
    };
    expect(body.customer.firstName).toBe("Dana");
    expect(body.tokens.accessToken).toBe("a");
    expect(dbMock.insertCustomer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cognitoSub: SUB, phone: PHONE, locale: "he-IL" }),
    );
  });

  it("logs in idempotently when the customer already exists (no insert)", async () => {
    fake.tickets.verify.mockResolvedValue(ticket);
    dbMock.findByCognitoSub.mockResolvedValue(customer);

    const res = await post("/auth/register", {
      registrationTicket: "payload.mac",
      firstName: "Dana",
      lastName: "Levi",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customer: { id: string } };
    expect(body.customer.id).toBe(customer.id);
    expect(dbMock.insertCustomer).not.toHaveBeenCalled();
  });

  it("401s on a forged or expired ticket", async () => {
    fake.tickets.verify.mockResolvedValue(null);
    const res = await post("/auth/register", {
      registrationTicket: "bad",
      firstName: "A",
      lastName: "B",
    });
    expect(res.status).toBe(401);
    expect(dbMock.insertCustomer).not.toHaveBeenCalled();
  });

  it("enqueues the optin_welcome outbox item after provisioning (ADR-0023)", async () => {
    fake.tickets.verify.mockResolvedValue(ticket);
    dbMock.findByCognitoSub.mockResolvedValue(undefined);
    dbMock.insertCustomer.mockResolvedValue(customer);

    const res = await post("/auth/register", {
      registrationTicket: "payload.mac",
      firstName: "Dana",
      lastName: "Levi",
      locale: "he-IL",
    });
    expect(res.status).toBe(200);
    expect(fake.outbox.put).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: SUB,
        phone: PHONE,
        messageType: "optin_welcome",
        language: "he",
        variables: { firstName: "Dana", appUrl: "https://dev.wanthat.app" },
        status: "pending",
      }),
    );
    // Chain log: outboxId is the field the dispatcher's notification_* lines share.
    expect(logMock.info).toHaveBeenCalledWith("optin_welcome_enqueued", {
      outboxId: expect.any(String),
      customerId: SUB,
    });
  });

  it("registration still succeeds when the outbox write fails (best-effort)", async () => {
    fake.tickets.verify.mockResolvedValue(ticket);
    dbMock.findByCognitoSub.mockResolvedValue(undefined);
    dbMock.insertCustomer.mockResolvedValue(customer);
    fake.outbox.put.mockRejectedValue(new Error("dynamo down"));

    const res = await post("/auth/register", {
      registrationTicket: "payload.mac",
      firstName: "Dana",
      lastName: "Levi",
    });
    expect(res.status).toBe(200);
    expect(logMock.error).toHaveBeenCalledWith("optin_welcome_enqueue_failed", {
      customerId: SUB,
      error: "dynamo down",
    });
  });

  it("does NOT enqueue on an idempotent re-register of an existing customer", async () => {
    fake.tickets.verify.mockResolvedValue(ticket);
    dbMock.findByCognitoSub.mockResolvedValue(customer);
    await post("/auth/register", {
      registrationTicket: "payload.mac",
      firstName: "D",
      lastName: "L",
    });
    expect(fake.outbox.put).not.toHaveBeenCalled();
  });
});
