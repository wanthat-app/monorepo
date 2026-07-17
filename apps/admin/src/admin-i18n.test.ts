import { afterEach, describe, expect, it, vi } from "vitest";
import { adminI18n } from "./admin-i18n";

/** In-memory localStorage stub; returns the backing map for assertions. */
function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("admin i18n instance", () => {
  it("translates the admin namespace in both languages", async () => {
    await adminI18n.changeLanguage("en");
    expect(adminI18n.t("admin.configuration")).toBe("Configuration");
    await adminI18n.changeLanguage("he");
    expect(adminI18n.t("admin.configuration")).toBe("תצורה");
  });

  it("persists under the console's own key (wanthat.adminLang), never the member app's", async () => {
    const store = stubStorage();
    await adminI18n.changeLanguage("en");
    expect(store.get("wanthat.adminLang")).toBe("en");
    // The member app's key stays untouched — the console never writes wanthat.lang.
    expect(store.has("wanthat.lang")).toBe(false);
  });
});
