import { afterEach, describe, expect, it, vi } from "vitest";
import { adminI18n } from "./admin-i18n";
import i18n from "./i18n";

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
  it("is independent of the member instance - the two languages work in parallel", async () => {
    await i18n.changeLanguage("he");
    await adminI18n.changeLanguage("en");
    expect(i18n.language).toBe("he");
    expect(adminI18n.language).toBe("en");
    expect(i18n.t("user.profile")).toBe("פרופיל");
    expect(adminI18n.t("user.profile")).toBe("Profile");

    // Flipping one instance leaves the other untouched, in both directions.
    await adminI18n.changeLanguage("he");
    expect(i18n.language).toBe("he");
    await i18n.changeLanguage("en");
    expect(adminI18n.language).toBe("he");
    expect(adminI18n.t("admin.configuration")).toBe("תצורה");
  });

  it("persists under its own key, never the member app's", async () => {
    const store = stubStorage();
    await adminI18n.changeLanguage("en");
    expect(store.get("wanthat.adminLang")).toBe("en");
    expect(store.has("wanthat.lang")).toBe(false);

    await i18n.changeLanguage("he");
    expect(store.get("wanthat.lang")).toBe("he");
    expect(store.get("wanthat.adminLang")).toBe("en"); // untouched by the member change
  });
});
