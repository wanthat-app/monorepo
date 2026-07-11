import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDocumentLanguage, claimDocumentLanguage } from "./document-language";

/** Minimal <html> stand-in — the module only touches documentElement.lang/dir. */
function stubDocument() {
  const el = { lang: "", dir: "" };
  vi.stubGlobal("document", { documentElement: el });
  return el;
}

afterEach(() => vi.unstubAllGlobals());

describe("document language ownership", () => {
  it("applies changes only from the current owner", () => {
    const el = stubDocument();
    claimDocumentLanguage("app", "he");
    expect(el).toEqual({ lang: "he", dir: "rtl" });

    // A non-owner change (the admin instance while the member app owns) is ignored.
    applyDocumentLanguage("admin", "en");
    expect(el).toEqual({ lang: "he", dir: "rtl" });

    applyDocumentLanguage("app", "en");
    expect(el).toEqual({ lang: "en", dir: "ltr" });
  });

  it("moves ownership on claim and hands it back (the admin mount/unmount cycle)", () => {
    const el = stubDocument();
    claimDocumentLanguage("admin", "en"); // admin console mounts in English
    expect(el).toEqual({ lang: "en", dir: "ltr" });

    // The member locale sync firing in the background must not flip the admin panel.
    applyDocumentLanguage("app", "he");
    expect(el).toEqual({ lang: "en", dir: "ltr" });

    claimDocumentLanguage("app", "he"); // admin console unmounts - member app takes over
    expect(el).toEqual({ lang: "he", dir: "rtl" });
  });

  it("no-ops without a document (SSR/tests)", () => {
    expect(() => claimDocumentLanguage("app", "he")).not.toThrow();
    expect(() => applyDocumentLanguage("app", "en")).not.toThrow();
  });
});
