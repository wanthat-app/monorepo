import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConfirmDeps, handleConfirmation, type PostConfirmationEvent } from "./confirm";

const deps = {
  notifications: { send: vi.fn().mockResolvedValue(undefined) },
  audit: { write: vi.fn().mockResolvedValue(undefined) },
  guests: { claim: vi.fn().mockResolvedValue(true) },
  counter: { incrementTotal: vi.fn().mockResolvedValue(undefined) },
  metrics: { incrementDaily: vi.fn().mockResolvedValue(undefined) },
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
  family_name: "Levi",
  email: "dana@example.com",
  locale: "he-IL",
};

// Pinned clock: claimedAt is asserted exactly, not with matchers.
const NOW = new Date("2026-07-09T10:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // clearAllMocks() does not reset implementations; re-pin the happy path (see message-sender).
  deps.notifications.send.mockResolvedValue(undefined);
  deps.audit.write.mockResolvedValue(undefined);
  deps.guests.claim.mockResolvedValue(true);
  deps.counter.incrementTotal.mockResolvedValue(undefined);
  deps.metrics.incrementDaily.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handleConfirmation — welcome notification (direct async invoke)", () => {
  it("invokes notification-sender with the optin_welcome payload the outbox used to carry", async () => {
    await handleConfirmation(deps, event(ATTRS));
    expect(deps.notifications.send).toHaveBeenCalledWith({
      messageType: "optin_welcome",
      phone: "+972541234567",
      language: "he",
      variables: { firstName: "Dana", appUrl: "https://dev.wanthat.app" },
    });
    expect(deps.log.info).toHaveBeenCalledWith("optin_welcome_invoked", {
      customerId: "sub-1234",
    });
    expect(deps.log.error).not.toHaveBeenCalled();
  });

  it("maps a non-Hebrew locale to en", async () => {
    await handleConfirmation(deps, event({ ...ATTRS, locale: "en-US" }));
    expect(deps.notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en" }),
    );
  });

  it("defaults a MISSING locale to Hebrew (Israeli-first, like the old register default)", async () => {
    await handleConfirmation(deps, event({ ...ATTRS, locale: undefined }));
    expect(deps.notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({ language: "he" }),
    );
  });

  it("sends an empty firstName when given_name is absent (attribute is optional at SignUp)", async () => {
    await handleConfirmation(deps, event({ ...ATTRS, given_name: undefined }));
    expect(deps.notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { firstName: "", appUrl: "https://dev.wanthat.app" } }),
    );
  });

  it("swallows an invoke failure — logs, never throws", async () => {
    deps.notifications.send.mockRejectedValue(new Error("lambda down"));
    await expect(handleConfirmation(deps, event(ATTRS))).resolves.toBeUndefined();
    expect(deps.log.error).toHaveBeenCalledWith("optin_welcome_invoke_failed", {
      customerId: "sub-1234",
      error: "lambda down",
    });
    expect(deps.log.info).not.toHaveBeenCalledWith("optin_welcome_invoked", expect.anything());
  });

  it("logs (not throws) on an event without phone_number", async () => {
    await expect(
      handleConfirmation(deps, event({ ...ATTRS, phone_number: undefined })),
    ).resolves.toBeUndefined();
    expect(deps.notifications.send).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledWith(
      "optin_welcome_invoke_failed",
      expect.objectContaining({ customerId: "sub-1234" }),
    );
  });
});

describe("handleConfirmation — signup audit (user_registered)", () => {
  it("invokes audit-writer with the profile fields from the Cognito attributes", async () => {
    await handleConfirmation(deps, event(ATTRS));
    expect(deps.audit.write).toHaveBeenCalledWith({
      event: "user_registered",
      sub: "sub-1234",
      phone: "+972541234567",
      firstName: "Dana",
      lastName: "Levi",
      email: "dana@example.com",
    });
    expect(deps.log.info).toHaveBeenCalledWith("signup_audit_invoked", { sub: "sub-1234" });
  });

  it("omits absent/empty profile attributes (the contract optionals are min(1))", async () => {
    await handleConfirmation(
      deps,
      event({ ...ATTRS, given_name: undefined, family_name: "", email: undefined }),
    );
    expect(deps.audit.write).toHaveBeenCalledWith({
      event: "user_registered",
      sub: "sub-1234",
      phone: "+972541234567",
    });
  });

  it("swallows an audit invoke failure — logs, never throws", async () => {
    deps.audit.write.mockRejectedValue(new Error("lambda down"));
    await expect(handleConfirmation(deps, event(ATTRS))).resolves.toBeUndefined();
    expect(deps.log.error).toHaveBeenCalledWith("signup_audit_invoke_failed", {
      sub: "sub-1234",
      error: "lambda down",
    });
  });

  it("still writes the audit row when the welcome invoke failed (steps are independent)", async () => {
    deps.notifications.send.mockRejectedValue(new Error("lambda down"));
    await handleConfirmation(deps, event(ATTRS));
    expect(deps.audit.write).toHaveBeenCalledTimes(1);
  });

  it("logs (not throws) on an event without phone_number", async () => {
    await handleConfirmation(deps, event({ ...ATTRS, phone_number: undefined }));
    expect(deps.audit.write).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledWith(
      "signup_audit_invoke_failed",
      expect.objectContaining({ sub: "sub-1234" }),
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

  it("still attempts the claim when the earlier invokes failed (steps are independent)", async () => {
    deps.notifications.send.mockRejectedValue(new Error("lambda down"));
    deps.audit.write.mockRejectedValue(new Error("lambda down"));
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

describe("handleConfirmation — exact customer counter", () => {
  it("increments the counter once per confirmed signup", async () => {
    await handleConfirmation(deps, event(ATTRS));
    expect(deps.counter.incrementTotal).toHaveBeenCalledTimes(1);
    expect(deps.log.info).toHaveBeenCalledWith("customer_counter_incremented", {
      sub: "sub-1234",
    });
  });

  it("swallows an increment failure — logs customer_counter_drift LOUDLY, never throws", async () => {
    deps.counter.incrementTotal.mockRejectedValue(new Error("dynamo down"));
    await expect(handleConfirmation(deps, event(ATTRS))).resolves.toBeUndefined();
    expect(deps.log.error).toHaveBeenCalledWith("customer_counter_drift", {
      op: "incrementTotal",
      sub: "sub-1234",
      error: "dynamo down",
    });
  });

  it("still increments when the earlier steps failed (steps are independent)", async () => {
    deps.notifications.send.mockRejectedValue(new Error("lambda down"));
    deps.guests.claim.mockRejectedValue(new Error("dynamo down"));
    await handleConfirmation(deps, event(ATTRS, { guestId: "guest-42" }));
    expect(deps.counter.incrementTotal).toHaveBeenCalledTimes(1);
  });
});

describe("handleConfirmation — daily signup counter", () => {
  it("bumps the daily signup counter with the Jerusalem date", async () => {
    await handleConfirmation(deps, event(ATTRS));
    // NOW is 10:00 UTC = 13:00 in Jerusalem, same calendar day.
    expect(deps.metrics.incrementDaily).toHaveBeenCalledWith("signupsDaily", "2026-07-09");
  });

  it("swallows a daily-counter failure — logs, never blocks confirmation", async () => {
    deps.metrics.incrementDaily.mockRejectedValue(new Error("dynamo down"));
    await expect(handleConfirmation(deps, event(ATTRS))).resolves.toBeUndefined();
    expect(deps.log.error).toHaveBeenCalledWith("signup_daily_count_failed", {
      sub: "sub-1234",
      error: "dynamo down",
    });
  });

  it("still counts the day when the earlier steps failed (steps are independent)", async () => {
    deps.counter.incrementTotal.mockRejectedValue(new Error("dynamo down"));
    await handleConfirmation(deps, event(ATTRS));
    expect(deps.metrics.incrementDaily).toHaveBeenCalledTimes(1);
  });
});

describe("handleConfirmation — foreign trigger sources", () => {
  it("no-ops on PostConfirmation_ConfirmForgotPassword", async () => {
    await handleConfirmation(
      deps,
      event(ATTRS, { guestId: "guest-42" }, "PostConfirmation_ConfirmForgotPassword"),
    );
    expect(deps.notifications.send).not.toHaveBeenCalled();
    expect(deps.audit.write).not.toHaveBeenCalled();
    expect(deps.guests.claim).not.toHaveBeenCalled();
    expect(deps.counter.incrementTotal).not.toHaveBeenCalled();
    expect(deps.metrics.incrementDaily).not.toHaveBeenCalled();
    expect(deps.log.info).not.toHaveBeenCalled();
    expect(deps.log.error).not.toHaveBeenCalled();
  });
});
