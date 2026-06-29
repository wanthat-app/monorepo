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
    continue: "Continue",
    verify: "Verify",
    resend: "Resend code",
    finish: "Create account",
    passkeyLogin: "Sign in with a passkey",
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
    continue: "המשך",
    verify: "אימות",
    resend: "שליחת קוד מחדש",
    finish: "יצירת חשבון",
    passkeyLogin: "כניסה עם מפתח גישה",
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

export default i18n;
