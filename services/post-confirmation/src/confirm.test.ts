import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConfirmDeps, handleConfirmation, type PostConfirmationEvent } from "./confirm";

const deps = {
  outbox: { put: vi.fn().mockResolvedValue(undefined) },
  guests: { claim: vi.fn().mockResolvedValue(true) },
  appUrl: "https://dev.wanthat.app",
  log: { info: vi.fn(), error: vi.fn() },
} satisfies ConfirmDeps;

function event(
  attrs: Record<string, string | undefined>,
  clientMetadata?: Record<string, string | undefined>,
  triggerSource = "PostConfirmation_ConfirmSignUp",
): PostConfirmationEvent {
  return {
    triggerSource,
    request: { userAttributes: attrs, ...(clientMetadata ? { clientMetadata } : {}) },
  };
}

const ATTRS = {
  sub: "sub-1234",
  phone_number: "+972541234567",
  given_name: "Dana",
  locale: "he-IL",
};

// Pinned clock: createdAt / claimedAt / ttl are asserted exactly, not with matchers.
const NOW = new Date("2026-07-09T10:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // clearAllMocks() does not reset implementations; re-pin the happy path (see message-sender).
  deps.outbox.put.mockResolvedValue(undefined);
  deps.guests.claim.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handleConfirmation — welcome outbox (ADR-0006 decision 7)", () => {
  it("writes the optin_welcome item exactly as /auth/register did", async () => {
    await handleConfirmation(deps, event(ATTRS));
    expect(deps.outbox.put).toHaveBeenCalledWith({
      outboxId: expect.any(String),
      customerId: "sub-1234",
      phone: "+972541234567",
      messageType: "optin_welcome",
      language: "he",
      variables: { firstName: "Dana", appUrl: "https://dev.wanthat.app" },
      status: "pending",
      createdAt: NOW.toISOString(),
      ttl: Math.floor(NOW.getTime() / 1000) + 30 * 24 * 3600,
    });
    const { outboxId } = deps.outbox.put.mock.calls[0]?.[0] as { outboxId: string };
    expect(deps.log.info).toHaveBeenCalledWith("optin_welcome_enqueued", {
      outboxId,
      customerId: "sub-1234",
    });
    expect(deps.log.error).not.toHaveBeenCalled();
  });

  it("maps a non-Hebrew locale to en", async () => {
    await handleConfirmation(deps, event({ ...ATTRS, locale: "en-US" }));
    expect(deps.outbox.put).toHaveBeenCalledWith(expect.objectContaining({ language: "en" }));
  });

  it("defaults a MISSING locale to Hebrew (Israeli-first, like the old register default)", async () => {
    await handleConfirmation(deps, event({ ...ATTRS, locale: undefined }));
    expect(deps.outbox.put).toHaveBeenCalledWith(expect.objectContaining({ language: "he" }));
  });

  it("sends an empty firstName when given_name is absent (attribute is optional at SignUp)", async () => {
    await handleConfirmation(deps, event({ ...ATTRS, given_name: undefined }));
    expect(deps.outbox.put).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { firstName: "", appUrl: "https://dev.wanthat.app" } }),
    );
  });

  it("swallows an outbox write failure — logs, never throws", async () => {
    deps.outbox.put.mockRejectedValue(new Error("dynamo down"));
    await expect(handleConfirmation(deps, event(ATTRS))).resolves.toBeUndefined();
    expect(deps.log.error).toHaveBeenCalledWith("optin_welcome_enqueue_failed", {
      customerId: "sub-1234",
      error: "dynamo down",
    });
    expect(deps.log.info).not.toHaveBeenCalled();
  });

  it("logs (not throws) on an event without phone_number", async () => {
    await expect(
      handleConfirmation(deps, event({ ...ATTRS, phone_number: undefined })),
    ).resolves.toBeUndefined();
    expect(deps.outbox.put).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledWith(
      "optin_welcome_enqueue_failed",
      expect.objectContaining({ customerId: "sub-1234" }),
    );
  });
});

describe("handleConfirmation — guest attribution (ADR-0008)", () => {
  it("claims guestId -> sub when ClientMetadata carries a guestId", async () => {
    await handleConfirmation(deps, event(ATTRS, { guestId: "guest-42" }));
    expect(deps.guests.claim).toHaveBeenCalledWith("guest-42", "sub-1234", NOW.toISOString());
    expect(deps.log.info).toHaveBeenCalledWith("guest_attribution_claimed", {
      guestId: "guest-42",
      sub: "sub-1234",
      created: true,
    });
  });

  it("skips the claim entirely when no guestId is present", async () => {
    await handleConfirmation(deps, event(ATTRS));
    await handleConfirmation(deps, event(ATTRS, { other: "x" }));
    expect(deps.guests.claim).not.toHaveBeenCalled();
  });

  it("swallows a claim failure — logs, never throws (must not block confirmation)", async () => {
    deps.guests.claim.mockRejectedValue(new Error("conditional write blew up"));
    await expect(
      handleConfirmation(deps, event(ATTRS, { guestId: "guest-42" })),
    ).resolves.toBeUndefined();
    expect(deps.log.error).toHaveBeenCalledWith("guest_attribution_claim_failed", {
      guestId: "guest-42",
      sub: "sub-1234",
      error: "conditional write blew up",
    });
  });

  it("still attempts the claim when the outbox write failed (steps are independent)", async () => {
    deps.outbox.put.mockRejectedValue(new Error("dynamo down"));
    await handleConfirmation(deps, event(ATTRS, { guestId: "guest-42" }));
    expect(deps.guests.claim).toHaveBeenCalledWith("guest-42", "sub-1234", NOW.toISOString());
  });

  it("an already-claimed guestId (created=false) is a fine outcome, logged as info", async () => {
    deps.guests.claim.mockResolvedValue(false);
    await handleConfirmation(deps, event(ATTRS, { guestId: "guest-42" }));
    expect(deps.log.info).toHaveBeenCalledWith(
      "guest_attribution_claimed",
      expect.objectContaining({ created: false }),
    );
    expect(deps.log.error).not.toHaveBeenCalled();
  });
});

describe("handleConfirmation — foreign trigger sources", () => {
  it("no-ops on PostConfirmation_ConfirmForgotPassword", async () => {
    await handleConfirmation(
      deps,
      event(ATTRS, { guestId: "guest-42" }, "PostConfirmation_ConfirmForgotPassword"),
    );
    expect(deps.outbox.put).not.toHaveBeenCalled();
    expect(deps.guests.claim).not.toHaveBeenCalled();
    expect(deps.log.info).not.toHaveBeenCalled();
    expect(deps.log.error).not.toHaveBeenCalled();
  });
});
