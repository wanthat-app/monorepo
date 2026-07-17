import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// The LANDING app's translation bundles — extracted from the member app's i18n.ts when the
// viral `/p/*` page moved to its own lean app (apps/landing): only the `shared.*` namespace the
// page renders, the biometric labels its auth module interpolates, and the header's login label.
// Hebrew-first (RTL), English fallback (ADR-0016).
const en = {
  app: { login: "Log in" },
  auth: {
    biometric: {
      faceId: "Face ID",
      touchId: "Touch ID",
      windowsHello: "Windows Hello",
      generic: "a passkey",
    },
  },
  shared: {
    onMerchant: "on {{merchant}}",
    sentLink: "recommended you a product",
    sentYouLink: "Someone sent you a cashback link",
    notFoundTitle: "Link not found",
    notFoundBody: "This link may have expired or never existed.",
    loadFailedTitle: "Something went wrong",
    loadFailedBody: "We couldn't load this link. Please try again in a moment.",
    signupEarnLabel: "Sign up and you'll earn",
    backOnOrder: "back on this order",
    twoSidedNote: "{{name}} earns from this too — that's how wanthat works.",
    twoSidedNoteGeneric: "Whoever shared it earns too — that's how wanthat works.",
    signupCta: "Start earning",
    signupTrust: "Free · 20-second SMS sign-up · withdraw straight to your bank",
    guestCta: "Continue as guest — no cashback",
    guestNote: "Goes straight to the store. You won't earn cashback on this order.",
    guestConsent: "Continuing as guest stores an anonymous id on this device.",
    welcomeBack: "Welcome back",
    signingIn: "Signing you in…",
    loggingBiometric: "Logging you in with {{label}}…",
    redirectingStore: "Taking you to {{merchant}} to complete your order…",
    earnOnThis: "You'll earn {{amount}} cashback on this order.",
    continueToStore: "Continue to {{merchant}}",
    retry: "Try again",
  },
};

const he: typeof en = {
  app: { login: "התחברות" },
  auth: {
    biometric: {
      faceId: "Face ID",
      touchId: "Touch ID",
      windowsHello: "Windows Hello",
      generic: "מפתח גישה",
    },
  },
  shared: {
    onMerchant: "ב-{{merchant}}",
    sentLink: "ממליץ/ה לך על מוצר",
    sentYouLink: "מישהו שלח לך קישור קאשבק",
    notFoundTitle: "הקישור לא נמצא",
    notFoundBody: "ייתכן שהקישור פג תוקף או שאינו קיים.",
    loadFailedTitle: "משהו השתבש",
    loadFailedBody: "לא הצלחנו לטעון את הקישור. נסו שוב בעוד רגע.",
    signupEarnLabel: "הירשמו ותרוויחו",
    backOnOrder: "חזרה על ההזמנה הזו",
    twoSidedNote: "גם {{name}} מרוויח/ה מזה — ככה wanthat עובד.",
    twoSidedNoteGeneric: "גם מי ששיתף מרוויח — ככה wanthat עובד.",
    signupCta: "התחילו להרוויח",
    signupTrust: "חינם · הרשמה ב-20 שניות · משיכה ישירה לבנק",
    guestCta: "המשיכו כאורח — ללא קאשבק",
    guestNote: "מעבר ישיר לחנות. לא תרוויחו קאשבק על ההזמנה הזו.",
    guestConsent: "המשך כאורח שומר מזהה אנונימי במכשיר הזה.",
    welcomeBack: "ברוכים השבים",
    signingIn: "מחברים אתכם…",
    loggingBiometric: "מתחברים עם {{label}}…",
    redirectingStore: "מעבירים אתכם ל-{{merchant}} להשלמת ההזמנה…",
    earnOnThis: "תקבלו {{amount}} קאשבק על ההזמנה הזאת.",
    continueToStore: "המשך ל-{{merchant}}",
    retry: "נסו שוב",
  },
};

export const resources = { he: { translation: he }, en: { translation: en } } as const;

/** Apply lang+dir to <html>; a missing document (SSR/tests) is a no-op. */
export function applyDocumentLanguage(lng: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lng;
  document.documentElement.dir = lng.startsWith("he") ? "rtl" : "ltr";
}

/** Read a remembered "he"/"en" choice; `fallback` when unset/unavailable (private mode, tests). */
export function storedLanguage(key: string, fallback: "he" | "en" = "he"): "he" | "en" {
  try {
    const stored = localStorage.getItem(key);
    return stored === "en" || stored === "he" ? stored : fallback;
  } catch {
    return fallback;
  }
}

// The member app's per-device language key, DELIBERATELY shared (same origin, same localStorage):
// a member who switched the app to English gets an English landing page, and vice versa. The
// landing page itself never writes it — the member app owns the choice.
const LANG_KEY = "wanthat.lang";

void i18n.use(initReactI18next).init({
  lng: storedLanguage(LANG_KEY),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  resources,
});

// Keep the document direction/lang in sync with the active locale (RTL for Hebrew — the default).
applyDocumentLanguage(i18n.language ?? "he");
i18n.on("languageChanged", (lng) => applyDocumentLanguage(lng));

export default i18n;
