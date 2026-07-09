import { describe, expect, it } from "vitest";
import { decodeJwtPayload, profileFromAttributes, profileFromIdToken } from "./claims";

/** Build an unsigned JWT with the given payload (base64url, UTF-8 — like Cognito's). */
function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

describe("profileFromIdToken", () => {
  it("decodes the full profile from ID-token claims, including Hebrew names (UTF-8 safe)", () => {
    const token = fakeJwt({
      sub: "11111111-1111-1111-1111-111111111111",
      phone_number: "+972541234567",
      given_name: "דנה",
      family_name: "לוי",
      email: "dana@example.com",
      locale: "he-IL",
      "custom:otpChannel": "sms",
    });
    expect(profileFromIdToken(token)).toEqual({
      sub: "11111111-1111-1111-1111-111111111111",
      phone: "+972541234567",
      firstName: "דנה",
      lastName: "לוי",
      email: "dana@example.com",
      locale: "he-IL",
      otpChannel: "sms",
    });
  });

  it("degrades missing optionals: no email → null, no channel → whatsapp, no locale → he-IL", () => {
    const profile = profileFromIdToken(fakeJwt({ sub: "s-1", phone_number: "+972541234567" }));
    expect(profile.email).toBeNull();
    expect(profile.otpChannel).toBe("whatsapp");
    expect(profile.locale).toBe("he-IL");
    expect(profile.firstName).toBe("");
  });

  it("never throws on a malformed token", () => {
    expect(profileFromIdToken("not-a-jwt").sub).toBe("");
    expect(decodeJwtPayload("a.%%%.c")).toEqual({});
    expect(decodeJwtPayload("")).toEqual({});
  });
});

describe("profileFromAttributes", () => {
  it("maps a GetUser attribute list to the same profile shape (fresh source after edits)", () => {
    const profile = profileFromAttributes([
      { Name: "sub", Value: "s-2" },
      { Name: "phone_number", Value: "+972501112233" },
      { Name: "given_name", Value: "Noa" },
      { Name: "family_name", Value: "Bar" },
      { Name: "locale", Value: "en-US" },
      { Name: "custom:otpChannel", Value: "whatsapp" },
    ]);
    expect(profile).toEqual({
      sub: "s-2",
      phone: "+972501112233",
      firstName: "Noa",
      lastName: "Bar",
      email: null,
      locale: "en-US",
      otpChannel: "whatsapp",
    });
  });
});
