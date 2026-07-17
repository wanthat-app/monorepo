/**
 * The document's language + direction, kept in sync with the member app's i18next instance
 * (RTL for Hebrew — the default — LTR for English). The old two-owner dance (member app vs the
 * admin console's second i18next instance) is gone: the admin console is its own app on its own
 * origin now, so this SPA is the document's only writer.
 */

/** Apply lang+dir to <html>; a missing document (SSR/tests) is a no-op. */
export function applyDocumentLanguage(lng: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lng;
  document.documentElement.dir = lng.startsWith("he") ? "rtl" : "ltr";
}
