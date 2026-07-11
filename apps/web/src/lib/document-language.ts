/**
 * Ownership of the document's language + direction. The SPA runs two independent i18next
 * instances — the member app (synced to the signed-in profile's locale) and the admin console
 * (its own persisted choice) — but there is only ONE <html dir>. Whoever owns the document
 * applies its language; changes on the other instance are ignored until ownership moves (the
 * admin shell claims on mount, releases on unmount), so a member-locale sync firing in the
 * background can never flip the admin panel's direction, and vice versa.
 */
export type DocumentLanguageOwner = "app" | "admin";

let owner: DocumentLanguageOwner = "app";

/** Apply lang+dir to <html> — only when `who` currently owns the document (no-op otherwise). */
export function applyDocumentLanguage(who: DocumentLanguageOwner, lng: string): void {
  if (who !== owner || typeof document === "undefined") return;
  document.documentElement.lang = lng;
  document.documentElement.dir = lng.startsWith("he") ? "rtl" : "ltr";
}

/** Hand document ownership to `who` and immediately apply its language. */
export function claimDocumentLanguage(who: DocumentLanguageOwner, lng: string): void {
  owner = who;
  applyDocumentLanguage(who, lng);
}
