import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDocumentLanguage } from "./document-language";

/** Minimal <html> stand-in — the module only touches documentElement.lang/dir. */
function stubDocument() {
  const el = { lang: "", dir: "" };
  vi.stubGlobal("document", { documentElement: el });
  return el;
}

afterEach(() => vi.unstubAllGlobals());

describe("document language", () => {
  it("applies lang and direction (RTL for Hebrew, LTR otherwise)", () => {
    const el = stubDocument();
    applyDocumentLanguage("he");
    expect(el).toEqual({ lang: "he", dir: "rtl" });
    applyDocumentLanguage("en");
    expect(el).toEqual({ lang: "en", dir: "ltr" });
  });

  it("no-ops without a document (SSR/tests)", () => {
    expect(() => applyDocumentLanguage("he")).not.toThrow();
  });
});
