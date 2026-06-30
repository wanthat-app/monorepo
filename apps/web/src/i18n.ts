import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// Hebrew-first (RTL), English fallback (ADR-0016).
const en = {
  app: { title: "Wanthat" },
  auth: {
    tagline: "Cashback on what you recommend",
    phoneLabel: "Phone number",
    codeLabel: "Verification code",
    firstName: "First name",
    lastName: "Last name",
    email: "Email (optional)",
    emailPlaceholder: "maya@email.com",
    language: "Language",
    continue: "Continue",
    verify: "Verify",
    resend: "Resend code",
    finish: "Create account",
    passkeyLogin: "Sign in with a passkey",
    registerTitle: "Almost there",
    registerSubtitle: "A few details to set up your cashback wallet.",
    agreePre: "I agree to the",
    terms: "Terms of Service",
    and: "and",
    privacy: "Privacy Policy",
    face: {
      title: "Faster sign-in with Face ID",
      subtitle: "Skip SMS codes next time — log in instantly and securely.",
      enable: "Enable Face ID",
      skip: "Maybe later",
    },
    errors: {
      generic: "Something went wrong. Please try again.",
      invalid_request: "Please check the details and try again.",
      invalid_code: "That code is incorrect or expired.",
      rate_limited: "Too many attempts. Please wait and try again.",
      sms_disabled: "SMS sign-in is temporarily unavailable.",
      challenge_not_found: "Your session expired. Please start again.",
      invalid_ticket: "Your session expired. Please start again.",
      ticket_expired: "Your session expired. Please start again.",
    },
  },
  home: {
    greeting: "Hi {{name}} 👋",
    placeholder: "Your wallet is coming soon.",
    enrollPasskey: "Set up FaceID / passkey",
    passkeyDone: "Passkey added.",
    signOut: "Sign out",
  },
};

const he: typeof en = {
  app: { title: "וונטהאט" },
  auth: {
    tagline: "קאשבק על מה שאתם ממליצים",
    phoneLabel: "מספר טלפון",
    codeLabel: "קוד אימות",
    firstName: "שם פרטי",
    lastName: "שם משפחה",
    email: "אימייל (לא חובה)",
    emailPlaceholder: "maya@email.com",
    language: "שפה",
    continue: "המשך",
    verify: "אימות",
    resend: "שליחת קוד מחדש",
    finish: "יצירת חשבון",
    passkeyLogin: "כניסה עם מפתח גישה",
    registerTitle: "כמעט סיימנו",
    registerSubtitle: "עוד כמה פרטים להגדרת ארנק הקאשבק שלכם.",
    agreePre: "אני מסכים/ה ל",
    terms: "תנאי השימוש",
    and: "ול",
    privacy: "מדיניות הפרטיות",
    face: {
      title: "התחברות מהירה עם Face ID",
      subtitle: "דלגו על קודי SMS בפעם הבאה — התחברו מיד ובאופן מאובטח.",
      enable: "הפעילו Face ID",
      skip: "אולי מאוחר יותר",
    },
    errors: {
      generic: "משהו השתבש. נסו שוב.",
      invalid_request: "בדקו את הפרטים ונסו שוב.",
      invalid_code: "הקוד שגוי או פג תוקף.",
      rate_limited: "יותר מדי ניסיונות. המתינו ונסו שוב.",
      sms_disabled: "כניסה ב-SMS אינה זמינה כרגע.",
      challenge_not_found: "הפעלה פגה. התחילו מחדש.",
      invalid_ticket: "הפעלה פגה. התחילו מחדש.",
      ticket_expired: "הפעלה פגה. התחילו מחדש.",
    },
  },
  home: {
    greeting: "היי {{name}} 👋",
    placeholder: "הארנק שלכם בקרוב.",
    enrollPasskey: "הגדרת FaceID / מפתח גישה",
    passkeyDone: "מפתח הגישה נוסף.",
    signOut: "התנתקות",
  },
};

void i18n.use(initReactI18next).init({
  lng: "he",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  resources: { he: { translation: he }, en: { translation: en } },
});

// Keep the document direction/lang in sync with the active locale so the layout mirrors (RTL for
// Hebrew, the default; LTR for English). Logical Tailwind properties handle the rest. Guarded so the
// module stays importable outside the browser (tests, SSR).
function applyDir(lng: string) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lng;
  document.documentElement.dir = lng.startsWith("he") ? "rtl" : "ltr";
}
applyDir(i18n.language ?? "he");
i18n.on("languageChanged", applyDir);

export default i18n;
