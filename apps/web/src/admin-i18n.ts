import i18next, { type i18n as I18nInstance } from "i18next";
import { rememberLanguage, resources, storedLanguage } from "./i18n";
import { applyDocumentLanguage } from "./lib/document-language";

/**
 * The ADMIN console's own i18next instance — deliberately separate from the member app's
 * default instance (i18n.ts). The member instance follows the signed-in profile's locale
 * (SessionProvider locale sync), so sharing it meant a member session flipping the admin
 * panel's language mid-use. This instance has its own persisted choice (`wanthat.adminLang`,
 * only the sidebar toggle writes it) and reaches the admin component tree via
 * <I18nextProvider i18n={adminI18n}> in AdminPage/AdminCallbackPage — both languages work in
 * parallel. NOT registered as react-i18next's default (that would displace the member
 * instance); document direction is applied only while the admin shell owns it.
 */
const ADMIN_LANG_KEY = "wanthat.adminLang";

export const adminI18n: I18nInstance = i18next.createInstance();
void adminI18n.init({
  lng: storedLanguage(ADMIN_LANG_KEY),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  resources,
});

adminI18n.on("languageChanged", (lng) => {
  applyDocumentLanguage("admin", lng);
  rememberLanguage(ADMIN_LANG_KEY, lng);
});
