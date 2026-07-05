import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// Hebrew-first (RTL), English fallback (ADR-0016).
const en = {
  app: { title: "Wanthat" },
  auth: {
    tagline: "Cashback on what you recommend",
    heading: "Cashback you can trust.",
    subheading:
      "Shop AliExpress through Wanthat and earn real money back — and again when friends use your links.",
    back: "Back",
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
    channelLabel: "Send the code via",
    channel: { whatsapp: "WhatsApp", sms: "SMS" },
    sentVia: {
      whatsapp: "We sent a code to your WhatsApp.",
      sms: "We sent a code by SMS.",
    },
    resendSms: "Didn't get it? Send via SMS",
    trySms: "Try SMS instead",
    finish: "Create account",
    passkeyCta: "Sign in with {{label}}",
    biometric: {
      faceId: "Face ID",
      touchId: "Touch ID",
      windowsHello: "Windows Hello",
      generic: "a passkey",
    },
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
      channel_disabled: "That sign-in method isn't available right now.",
      send_failed: "We couldn't send the code. Please try again.",
      challenge_not_found: "Your session expired. Please start again.",
      invalid_ticket: "Your session expired. Please start again.",
      ticket_expired: "Your session expired. Please start again.",
      passkey_unavailable: "No passkey found for this device. Sign in with a code.",
      invalid_passkey: "Biometric sign-in failed. Try again or use a code.",
    },
  },
  home: {
    greeting: "Hi {{name}} 👋",
    placeholder: "Your wallet is coming soon.",
    enrollPasskey: "Set up FaceID / passkey",
    passkeyDone: "Passkey added.",
    signOut: "Sign out",
  },
  admin: {
    brand: "wanthat",
    operations: "Operations",
    overview: "Overview",
    settings: "Settings",
    dashboard: "Dashboard",
    configuration: "Configuration",
    role: "Platform admin",
    you: "Admin",
    signOut: "Sign out",
    notAuthorised: "Not authorised.",
    search: "Search users, links, payouts…",
    notifications: "Notifications",
    language: "Language",
    dashboardSub: "Cashback performance across the platform",
    configSub: "Reward rules, payouts and feature flags",
    comingSoon: "Coming soon",
    comingSoonHint: "Charts, the approvals queue and top-earning links land in a later slice.",
    loadError: "Failed to load configuration.",
    live: "live",
    stats: {
      users: "Active users",
      pending: "Pending payouts",
      cashback: "Cashback paid",
      conversions: "Link conversion",
    },
    sections: {
      marginsTitle: "Margins & rewards",
      marginsDesc: "How affiliate commission is split between wanthat, referrers and buyers.",
      payoutsTitle: "Payouts & FX",
      payoutsDesc: "Settlement-currency conversion and how often rates refresh.",
      automationTitle: "Automation & features",
      automationDesc: "Conversion polling and consumer-facing sign-in controls.",
    },
    units: { minutes: "min", hours: "hrs", sends: "sends" },
    fxProvider: { ecb: "ECB", boi: "BoI" },
    save: {
      unsaved: "You have unsaved changes.",
      saved: "All changes saved.",
      error: "Some changes failed to save.",
      discard: "Discard",
      save: "Save changes",
      saving: "Saving…",
      done: "Saved",
    },
    keys: {
      cashback_referrerBps: {
        title: "Referrer reward",
        desc: "Share of retailer commission paid to the referrer on new links.",
      },
      cashback_consumerBps: {
        title: "Buyer reward",
        desc: "Share paid to the buyer on new links (two-sided reward).",
      },
      fx_conversionCommissionBps: {
        title: "FX conversion commission",
        desc: "Withheld on settlement-currency conversion so displayed balances are all-in.",
      },
      fx_provider: { title: "FX rate source", desc: "Which exchange-rate provider is live." },
      fx_updateIntervalMinutes: {
        title: "FX refresh interval",
        desc: "How often the FX rate cache is refreshed.",
      },
      poller_intervalMinutes: {
        title: "Poller interval",
        desc: "How often the conversion poller runs.",
      },
      poller_lookbackHours: {
        title: "Poller lookback",
        desc: "How far back each poll re-scans for status changes.",
      },
      auth_smsEnabled: {
        title: "SMS one-time codes",
        desc: "Master switch for SMS OTP sign-in (kill switch during abuse).",
      },
      auth_smsMaxPerWindow: {
        title: "SMS sends per window",
        desc: "Maximum OTP sends per phone before lockout.",
      },
      auth_smsLockoutMinutes: {
        title: "SMS lockout window",
        desc: "How long the per-phone send counter is held.",
      },
    },
  },
};

const he: typeof en = {
  app: { title: "וונטהאט" },
  auth: {
    tagline: "קאשבק על מה שאתם ממליצים",
    heading: "קאשבק שאפשר לסמוך עליו.",
    subheading:
      "קנו ב-AliExpress דרך Wanthat והרוויחו כסף אמיתי בחזרה — והרוויחו שוב כשחברים משתמשים בקישורים שלכם.",
    back: "חזרה",
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
    channelLabel: "לאן לשלוח את הקוד",
    channel: { whatsapp: "וואטסאפ", sms: "SMS" },
    sentVia: {
      whatsapp: "שלחנו קוד לוואטסאפ שלך.",
      sms: "שלחנו קוד ב-SMS.",
    },
    resendSms: "לא הגיע? שליחה ב-SMS",
    trySms: "לנסות ב-SMS",
    finish: "יצירת חשבון",
    passkeyCta: "כניסה עם {{label}}",
    biometric: {
      faceId: "Face ID",
      touchId: "Touch ID",
      windowsHello: "Windows Hello",
      generic: "מפתח גישה",
    },
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
      channel_disabled: "שיטת הכניסה הזו אינה זמינה כרגע.",
      send_failed: "לא הצלחנו לשלוח את הקוד. נסו שוב.",
      challenge_not_found: "הפעלה פגה. התחילו מחדש.",
      invalid_ticket: "הפעלה פגה. התחילו מחדש.",
      ticket_expired: "הפעלה פגה. התחילו מחדש.",
      passkey_unavailable: "לא נמצא מפתח גישה במכשיר. היכנסו עם קוד.",
      invalid_passkey: "הכניסה הביומטרית נכשלה. נסו שוב או היכנסו עם קוד.",
    },
  },
  home: {
    greeting: "היי {{name}} 👋",
    placeholder: "הארנק שלכם בקרוב.",
    enrollPasskey: "הגדרת FaceID / מפתח גישה",
    passkeyDone: "מפתח הגישה נוסף.",
    signOut: "התנתקות",
  },
  admin: {
    brand: "wanthat",
    operations: "תפעול",
    overview: "סקירה",
    settings: "הגדרות",
    dashboard: "לוח בקרה",
    configuration: "תצורה",
    role: "מנהל פלטפורמה",
    you: "מנהל",
    signOut: "התנתקות",
    notAuthorised: "אין הרשאה.",
    search: "חיפוש משתמשים, קישורים, תשלומים…",
    notifications: "התראות",
    language: "שפה",
    dashboardSub: "ביצועי קאשבק ברחבי הפלטפורמה",
    configSub: "כללי תגמול, תשלומים ודגלי תכונות",
    comingSoon: "בקרוב",
    comingSoonHint: "גרפים, תור האישורים והקישורים המרוויחים ביותר יגיעו בשלב מאוחר יותר.",
    loadError: "טעינת התצורה נכשלה.",
    live: "חי",
    stats: {
      users: "משתמשים פעילים",
      pending: "תשלומים ממתינים",
      cashback: "קאשבק ששולם",
      conversions: "המרת קישורים",
    },
    sections: {
      marginsTitle: "מרווחים ותגמולים",
      marginsDesc: "כיצד עמלת השותפים מתחלקת בין wanthat, הממליצים והקונים.",
      payoutsTitle: 'תשלומים ומט"ח',
      payoutsDesc: "המרת מטבע הסליקה ותדירות רענון השערים.",
      automationTitle: "אוטומציה ותכונות",
      automationDesc: "סקירת המרות ובקרות כניסה הפונות למשתמש.",
    },
    units: { minutes: "דק׳", hours: "שע׳", sends: "שליחות" },
    fxProvider: { ecb: "ECB", boi: "בנק ישראל" },
    save: {
      unsaved: "יש לך שינויים שלא נשמרו.",
      saved: "כל השינויים נשמרו.",
      error: "חלק מהשינויים לא נשמרו.",
      discard: "ביטול",
      save: "שמירת שינויים",
      saving: "שומר…",
      done: "נשמר",
    },
    keys: {
      cashback_referrerBps: {
        title: "תגמול ממליץ",
        desc: "חלק מעמלת הסוחר המשולם לממליץ בקישורים חדשים.",
      },
      cashback_consumerBps: {
        title: "תגמול קונה",
        desc: "חלק המשולם לקונה בקישורים חדשים (תגמול דו-צדדי).",
      },
      fx_conversionCommissionBps: {
        title: 'עמלת המרת מט"ח',
        desc: "מנוכה בהמרת מטבע הסליקה כדי שהיתרות המוצגות יהיו כוללניות.",
      },
      fx_provider: { title: "מקור שער החליפין", desc: "איזה ספק שערי חליפין פעיל." },
      fx_updateIntervalMinutes: {
        title: 'תדירות רענון מט"ח',
        desc: "כל כמה זמן מרעננים את מטמון שערי החליפין.",
      },
      poller_intervalMinutes: {
        title: "תדירות סקירה",
        desc: "כל כמה זמן רץ סוקר ההמרות.",
      },
      poller_lookbackHours: {
        title: "טווח סריקה לאחור",
        desc: "כמה אחורה כל סריקה בודקת שינויי סטטוס.",
      },
      auth_smsEnabled: {
        title: "קודי SMS חד-פעמיים",
        desc: "מתג ראשי לכניסה עם קוד SMS (מנגנון נטרול בעת ניצול לרעה).",
      },
      auth_smsMaxPerWindow: {
        title: "שליחות SMS לחלון",
        desc: "מספר שליחות מרבי לטלפון לפני נעילה.",
      },
      auth_smsLockoutMinutes: {
        title: "חלון נעילת SMS",
        desc: "כמה זמן מוחזק מונה השליחות לכל טלפון.",
      },
    },
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
