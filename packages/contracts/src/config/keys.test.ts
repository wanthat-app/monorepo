import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, CONFIG_KEYS, CONFIG_SCHEMAS } from "./keys";

describe("poller confirmed-scan config keys", () => {
  it("registers both keys in CONFIG_KEYS", () => {
    expect(CONFIG_KEYS).toContain("poller.confirmScanDays");
    expect(CONFIG_KEYS).toContain("poller.confirmScanIntervalMinutes");
  });

  it("poller.confirmScanDays defaults to 80, under the listbyindex span cap", () => {
    expect(CONFIG_DEFAULTS["poller.confirmScanDays"]).toBe(80);
    expect(CONFIG_SCHEMAS["poller.confirmScanDays"].parse(85)).toBe(85);
    expect(() => CONFIG_SCHEMAS["poller.confirmScanDays"].parse(400)).toThrow();
    expect(() => CONFIG_SCHEMAS["poller.confirmScanDays"].parse(0)).toThrow();
  });

  it("poller.confirmScanIntervalMinutes defaults to 720", () => {
    expect(CONFIG_DEFAULTS["poller.confirmScanIntervalMinutes"]).toBe(720);
    expect(CONFIG_SCHEMAS["poller.confirmScanIntervalMinutes"].parse(1440)).toBe(1440);
    expect(() => CONFIG_SCHEMAS["poller.confirmScanIntervalMinutes"].parse(5)).toThrow();
  });
});
