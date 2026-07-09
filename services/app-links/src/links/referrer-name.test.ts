import { describe, expect, it, vi } from "vitest";
import { referrerFirstName } from "./referrer-name";

const clientWith = (attrs: { Name: string; Value?: string }[] | Error) => ({
  send: vi.fn(async () => {
    if (attrs instanceof Error) throw attrs;
    return { UserAttributes: attrs };
  }),
});

describe("referrerFirstName", () => {
  it("returns the trimmed given_name", async () => {
    const client = clientWith([{ Name: "given_name", Value: "  Dana " }]);
    await expect(referrerFirstName("tok", { client } as never)).resolves.toBe("Dana");
  });

  it("returns null without a token, without the attribute, or on error", async () => {
    await expect(referrerFirstName(undefined)).resolves.toBeNull();
    await expect(referrerFirstName("tok", { client: clientWith([]) } as never)).resolves.toBeNull();
    await expect(
      referrerFirstName("tok", { client: clientWith(new Error("denied")) } as never),
    ).resolves.toBeNull();
  });
});
