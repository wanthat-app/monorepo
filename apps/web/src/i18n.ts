import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// Hebrew-first (RTL), English fallback (ADR-0016). Real strings move to src/locales/*.
void i18n.use(initReactI18next).init({
  lng: "he",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  resources: {
    he: { translation: { app: { title: "וונטהאט" } } },
    en: { translation: { app: { title: "Wanthat" } } },
  },
});

export default i18n;
