import { describe, expect, it } from "vitest";
import { parseMasterSecret } from "./handler";

describe("parseMasterSecret", () => {
  it("extracts username/password from the RDS-generated secret JSON", () => {
    const secret = JSON.stringify({
      username: "wanthat_master",
      password: "s3cret",
      engine: "postgres",
      host: "ignored",
      port: 5432,
      dbname: "wanthat",
    });
    expect(parseMasterSecret(secret)).toEqual({ username: "wanthat_master", password: "s3cret" });
  });

  it("throws on malformed secrets instead of connecting with garbage", () => {
    expect(() => parseMasterSecret("{}")).toThrow("missing username/password");
    expect(() => parseMasterSecret(JSON.stringify({ username: "x" }))).toThrow(
      "missing username/password",
    );
    expect(() => parseMasterSecret("not-json")).toThrow();
  });
});
