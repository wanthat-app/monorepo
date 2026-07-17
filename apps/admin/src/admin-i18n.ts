import i18next, { type i18n as I18nInstance } from "i18next";
import { rememberLanguage, resources, storedLanguage } from "./i18n";

/**
 * The admin console's i18next instance. Historically a second instance beside the member app's
 * (they shared one document); since the console moved to its own origin it is the ONLY instance
 * here, but it keeps its own persisted choice (`wanthat.adminLang` — the sidebar toggle writes
 * it) and reaches the component tree via <I18nextProvider i18n={adminI18n}> (AdminI18nProvider),
 * exactly as before. This app always owns the document, so language changes apply <html lang/dir>
 * directly (RTL for Hebrew, the default).
 */
const ADMIN_LANG_KEY = "wanthat.adminLang";

/** Apply lang+dir to <html> — this app is the console, so it always owns the document. */
export function applyDocumentLanguage(lng: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lng;
  document.documentElement.dir = lng.startsWith("he") ? "rtl" : "ltr";
}

export const adminI18n: I18nInstance = i18next.createInstance();
void adminI18n.init({
  lng: storedLanguage(ADMIN_LANG_KEY),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  resources,
});

applyDocumentLanguage(adminI18n.language ?? "he");
adminI18n.on("languageChanged", (lng) => {
  applyDocumentLanguage(lng);
  rememberLanguage(ADMIN_LANG_KEY, lng);
});
