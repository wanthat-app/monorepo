import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { applyDocumentLanguage } from "./lib/document-language";

// Hebrew-first (RTL), English fallback (ADR-0016).
const en = {
  app: { title: "Wanthat", login: "Log in" },
  // Logged-out app landing at `/` (design: Wallet flow "app-landing"); one CTA — login and
  // signup are the same phone-first flow (ADR-0006), so the landing doesn't split them.
  landing: {
    headline: "Real cashback on every order at the most popular stores.",
    sub: "Shop through wanthat, earn money back — and earn again when friends use your links.",
    availableCashback: "Available cashback",
    sample: "Sample",
    sampleNote: "Illustrative balance — your real cashback appears once you join.",
    earnEveryOrder: "Earn on every order",
    earnEveryOrderSub: "Up to 10% back, withdraw it directly.",
    earnFromLinks: "Earn from recommendations",
    earnFromLinksSub: "Friends buy — you both earn.",
    secure: "Secure by design",
    secureSub: "SMS codes + Face ID sign-in.",
    registerCta: "Let me join",
  },
  auth: {
    heading: "Recommendations you can trust.",
    subheading:
      "Shop the most popular stores through wanthat and earn real money back — and earn again when friends use your links.",
    back: "Back",
    phoneLabel: "Phone number",
    phoneCta: "Send me a code",
    phoneHelper: "We'll text a one-time code to verify it's you.",
    otpTitle: "Enter your code",
    otpSent: "We sent a {{digits}}-digit code to",
    resendPre: "Didn't get it?",
    resendIn: "Resend in {{time}}",
    skipCodes: "Skip codes next time",
    skipCodesSub: "Turn on Face ID / passkey after sign-in.",
    codeLabel: "Verification code",
    firstName: "First name",
    lastName: "Last name",
    email: "Email (optional)",
    emailPlaceholder: "name@email.com",
    language: "Language",
    continue: "Continue",
    verify: "Verify",
    resend: "Send again",
    channelLabel: "Send the code via",
    channel: { whatsapp: "WhatsApp", sms: "SMS" },
    finish: "Create account",
    passkeyCta: "Sign in with {{label}}",
    passkeyFallback: "Biometric sign-in didn't work here — enter your phone and we'll send a code.",
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
      title: "Faster sign-in with {{label}}",
      subtitle: "Skip SMS codes next time — log in instantly and securely.",
      enable: "Enable {{label}}",
      skip: "Maybe later",
    },
    errors: {
      generic: "Something went wrong. Please try again.",
      invalid_request: "Please check the details and try again.",
      invalid_code: "That code is incorrect. Try again.",
      code_expired: "That code has expired. Request a new one.",
      not_authorized: "Sign-in failed. Please start again.",
      rate_limited: "Too many attempts. Please wait and try again.",
      send_failed: "We couldn't send the code. Please try again.",
      phone_exists: "This phone number is already registered — sign in instead.",
      email_exists: "That email is already in use on another account.",
      invalid_passkey: "Biometric sign-in failed. Try again or use a code.",
    },
  },
  user: {
    menuLabel: "Account",
    profile: "Profile",
    passkeys: "Passkeys",
    signOut: "Sign out",
    profileTitle: "Your details",
    save: "Save changes",
    saved: "Saved.",
    emailCodeSent: "We sent a code to your new email — enter it to verify.",
    emailCodeLabel: "Email verification code",
    verifyEmail: "Verify email",
    passkeysEmpty: "No passkeys yet — add one to skip codes next time.",
    addPasskey: "Add {{label}}",
    passkeyGeneric: "Passkey",
  },
  home: {
    availableCashback: "Available cashback", // (design)
    estimated: "At current FX rates", // 2026-07-21: honest label — the ≈ILS figure moves with rates
    heldNote: "held in original currencies", // (design)
    pendingNote: "≈{{amount}} pending confirmation", // (design, parameterised)
    counting: "Counting the money…", // cold-start indicator (spec 2026-07-21-cold-start-cache)
    lastCounted: "Last counted: {{amount}}", // hero layout: last known total chip
    withdrawCash: "Withdraw (coming soon)", // payout flow not built yet (design: withdrawToBank)
    recentActivity: "Recent activity", // (design)
    seeAll: "See all", // (design)
    noActivity: "No activity yet — cashback from your links will show up here.",
    createLink: "Recommend",
    navHome: "Home", // (design)
    navActivity: "Activity", // (design)
    setupFaceId: "Set up Face ID", // (design)
    setupFaceIdSub: "Skip SMS codes — log in instantly next time.", // (design)
    turnOn: "Turn on", // (design)
    passkeyDone: "Passkey added.",
    signOut: "Sign out",
    loadFailed: "Couldn't load your wallet.",
    retry: "Retry",
    status: {
      confirmed: "Confirmed", // (design)
      pending: "Pending", // (design)
      clawback: "Returned", // (design: returned)
    },
    kind: {
      referrer_cashback: "Recommendation cashback",
      consumer_reward: "Your cashback",
      adjustment: "Adjustment",
      withdrawal: "Withdrawal",
      recommendation_created: "Recommended",
    },
    turnLinkTitle: "Turn a link into cashback", // (design)
    turnLinkSub: "Paste any product link and share your recommendation.",
    pastePlaceholder: "Paste product link…", // (design)
  },
  memberActivity: {
    title: "Activity",
    loadMore: "Load more",
    share: "Share",
  },
  create: {
    title: "Recommend to friends",
    linkLabel: "Product link",
    pastePlaceholder: "Paste product link…", // (design)
    hint: "Paste a link — we'll pull the product automatically.", // (design)
    cta: "Recommend",
    pulling: "Pulling product details…", // (design)
    unsupported: "Only AliExpress product links are supported right now.",
    notConfigured: "Link creation isn't available right now. Please try again later.",
    notSupported:
      "AliExpress doesn't offer cashback on this item, so a link can't be created for it.",
    resolveFailed: "We couldn't pull that product. Please try again.",
    linkReady: "Your link is ready", // (design)
    detailsPulled: "Details pulled from the store",
    youEarnSale: "You earn / sale", // (design)
    theyEarn: "They earn", // (design)
    reviewLabel: "Add your review (optional)", // (design)
    reviewPlaceholder: "Tell your friends why you recommend it…", // (design)
    reviewHint: "Friends see this as your personal recommendation when they open the link.", // (design)
    shareManyNote:
      "Share with as many friends as you like — you earn {{amount}} every time one of them buys.", // (design, parameterised)
    shareManyNoteNoAmount:
      "Share with as many friends as you like — you earn cashback every time one of them buys.",
    copy: "Copy", // (design)
    copied: "Copied!", // (design)
    share: "Share with friends", // (design)
    done: "Done", // (design)
    createFailed: "We couldn't create your link. Please try again.",
  },
  notFound: {
    title: "Page not found",
    message: "The page you're looking for doesn't exist or has moved.",
    home: "Back to home",
  },
  error: {
    oops: "Oops",
    title: "Something went wrong",
    message: "An unexpected error occurred. Please try again.",
    retry: "Reload",
    home: "Back to home",
  },
  // SAMPLE legal copy — placeholder for counsel-approved text; the pages carry a draft notice.
  legal: {
    sampleNotice: "Sample draft — for review only, not yet binding.",
    updated: "Last updated: July 2026",
    terms: {
      title: "Terms of Service",
      sections: [
        {
          h: "1. The service",
          p: "wanthat lets members earn real cashback on purchases made through wanthat links at partner stores — and earn again when friends buy through links they share.",
        },
        {
          h: "2. Your account",
          p: "One account per person, verified by phone number. You are responsible for keeping access to your device and phone number; sign-in codes and passkeys are personal and must not be shared.",
        },
        {
          h: "3. Cashback and withdrawals",
          p: "Cashback becomes available only after the partner store confirms the order; cancelled or returned orders forfeit it. Amounts shown in ₪ before confirmation are estimates based on exchange rates. Withdrawals are made to the payout methods offered in the app.",
        },
        {
          h: "4. Acceptable use",
          p: "No self-dealing, misleading recommendations, or automated abuse. We may suspend accounts that attempt to game the program, and withhold cashback obtained in breach of these terms.",
        },
        {
          h: "5. Changes and contact",
          p: "We may update these terms from time to time; material changes will be announced in the app. Questions: support@wanthat.app.",
        },
      ],
    },
    privacy: {
      title: "Privacy Policy",
      sections: [
        {
          h: "1. What we collect",
          p: "Your phone number, name, optional email and language preference; the links you create, orders attributed to them, and your wallet activity.",
        },
        {
          h: "2. How we use it",
          p: "To run the cashback program: verifying you by SMS/WhatsApp code, attributing orders to your links, calculating and paying cashback, and showing your activity in the app.",
        },
        {
          h: "3. Sharing",
          p: "Order data is exchanged with partner stores and affiliate networks solely to confirm purchases and cashback. We do not sell personal data.",
        },
        {
          h: "4. Retention and security",
          p: "Personal data and money movements are stored encrypted, with money records kept in an audited ledger, for as long as your account exists or the law requires.",
        },
        {
          h: "5. Your rights",
          p: "You can edit your profile in the app at any time, and contact us to export or delete your account data: support@wanthat.app.",
        },
      ],
    },
  },
  // No `shared.*` namespace any more: the referral landing (`/p/*`) is its own lean app
  // (apps/landing) and carries those strings itself.
};

const he: typeof en = {
  app: { title: "וונטהאט", login: "התחברות" },
  landing: {
    headline: "קאשבק אמיתי על כל הזמנה בחנויות הכי פופולריות.",
    sub: "קנו דרך wanthat, קבלו כסף בחזרה — והרוויחו שוב כשחברים משתמשים בקישורים שלכם.",
    availableCashback: "קאשבק זמין",
    sample: "דוגמה",
    sampleNote: "יתרה להמחשה — הקאשבק האמיתי שלכם יופיע לאחר ההצטרפות.",
    earnEveryOrder: "מרוויחים על כל הזמנה",
    earnEveryOrderSub: "עד 10% בחזרה, במשיכה ישירה.",
    earnFromLinks: "מרוויחים מהמלצות",
    earnFromLinksSub: "חברים קונים — שניכם מרוויחים.",
    secure: "מאובטח מהיסוד",
    secureSub: "קודי SMS והתחברות ב-Face ID.",
    registerCta: "צרפו אותי",
  },
  auth: {
    heading: "המלצות שאפשר לסמוך עליהן.",
    subheading:
      "קנו בחנויות הכי פופולריות דרך wanthat והרוויחו כסף אמיתי בחזרה — והרוויחו שוב כשחברים משתמשים בקישורים שלכם.",
    back: "חזרה",
    phoneLabel: "מספר טלפון",
    phoneCta: "שלחו לי קוד",
    phoneHelper: "נשלח לכם קוד חד-פעמי לאימות.",
    otpTitle: "הזינו את הקוד",
    otpSent: "שלחנו קוד בן {{digits}} ספרות אל",
    resendPre: "לא קיבלתם?",
    resendIn: "שליחה חוזרת בעוד {{time}}",
    skipCodes: "דלגו על קודים בפעם הבאה",
    skipCodesSub: "הפעילו Face ID / מפתח גישה אחרי ההתחברות.",
    codeLabel: "קוד אימות",
    firstName: "שם פרטי",
    lastName: "שם משפחה",
    email: "אימייל (לא חובה)",
    emailPlaceholder: "name@email.com",
    language: "שפה",
    continue: "המשך",
    verify: "אימות",
    resend: "שלחו שוב",
    channelLabel: "לאן לשלוח את הקוד",
    channel: { whatsapp: "וואטסאפ", sms: "SMS" },
    finish: "יצירת חשבון",
    passkeyCta: "כניסה עם {{label}}",
    passkeyFallback: "הכניסה הביומטרית לא הצליחה כאן — הזינו את מספר הטלפון ונשלח לכם קוד.",
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
      title: "התחברות מהירה עם {{label}}",
      subtitle: "דלגו על קודי SMS בפעם הבאה — התחברו מיד ובאופן מאובטח.",
      enable: "הפעלת {{label}}",
      skip: "אולי מאוחר יותר",
    },
    errors: {
      generic: "משהו השתבש. נסו שוב.",
      invalid_request: "בדקו את הפרטים ונסו שוב.",
      invalid_code: "הקוד שגוי. נסו שוב.",
      code_expired: "הקוד פג תוקף. בקשו קוד חדש.",
      not_authorized: "הכניסה נכשלה. התחילו מחדש.",
      rate_limited: "יותר מדי ניסיונות. המתינו ונסו שוב.",
      send_failed: "לא הצלחנו לשלוח את הקוד. נסו שוב.",
      phone_exists: "מספר הטלפון הזה כבר רשום — היכנסו במקום להירשם.",
      email_exists: "האימייל הזה כבר בשימוש בחשבון אחר.",
      invalid_passkey: "הכניסה הביומטרית נכשלה. נסו שוב או היכנסו עם קוד.",
    },
  },
  user: {
    menuLabel: "חשבון",
    profile: "פרופיל",
    passkeys: "מפתחות גישה",
    signOut: "התנתקות",
    profileTitle: "הפרטים שלך",
    save: "שמירת שינויים",
    saved: "נשמר.",
    emailCodeSent: "שלחנו קוד לאימייל החדש — הזינו אותו לאימות.",
    emailCodeLabel: "קוד אימות אימייל",
    verifyEmail: "אימות אימייל",
    passkeysEmpty: "אין מפתחות גישה עדיין — הוסיפו אחד כדי לדלג על קודים בפעם הבאה.",
    addPasskey: "הוספת {{label}}",
    passkeyGeneric: "מפתח גישה",
  },
  home: {
    availableCashback: "קאשבק זמין",
    estimated: "לפי שערי מטבע",
    heldNote: "מוחזק במטבע המקורי",
    pendingNote: "≈{{amount}} ממתין לאישור",
    counting: "סופרים את הכסף…",
    lastCounted: "נספר לאחרונה: {{amount}}",
    withdrawCash: "משיכה (בקרוב)",
    recentActivity: "פעילות אחרונה",
    seeAll: "הצג הכל",
    noActivity: "אין פעילות עדיין — קאשבק מהקישורים שלכם יופיע כאן.",
    createLink: "המליצו",
    navHome: "בית",
    navActivity: "פעילות",
    setupFaceId: "הגדרת Face ID",
    setupFaceIdSub: "דלגו על קודי SMS — התחברו מיד בפעם הבאה.",
    turnOn: "הפעלה",
    passkeyDone: "מפתח הגישה נוסף.",
    signOut: "התנתקות",
    loadFailed: "לא הצלחנו לטעון את הארנק.",
    retry: "נסו שוב",
    status: {
      confirmed: "אושר",
      pending: "ממתין",
      clawback: "הוחזר",
    },
    kind: {
      referrer_cashback: "קאשבק מהמלצה",
      consumer_reward: "הקאשבק שלכם",
      adjustment: "התאמה",
      withdrawal: "משיכה",
      recommendation_created: "המלצתם",
    },
    turnLinkTitle: "הפכו קישור לקאשבק",
    turnLinkSub: "הדביקו קישור למוצר ושתפו את ההמלצה שלכם.",
    pastePlaceholder: "הדביקו קישור למוצר…",
  },
  memberActivity: {
    title: "פעילות",
    loadMore: "טען עוד",
    share: "שיתוף",
  },
  create: {
    title: "המליצו לחברים",
    linkLabel: "קישור למוצר",
    pastePlaceholder: "הדביקו קישור למוצר…",
    hint: "הדביקו קישור — נשלוף את המוצר אוטומטית.",
    cta: "המליצו",
    pulling: "שולפים פרטי מוצר…",
    unsupported: "כרגע נתמכים רק קישורי מוצר מ-AliExpress.",
    notConfigured: "יצירת קישורים אינה זמינה כרגע. נסו שוב מאוחר יותר.",
    notSupported: "AliExpress אינו מציע קאשבק על מוצר זה, לכן לא ניתן ליצור עבורו קישור.",
    resolveFailed: "לא הצלחנו לשלוף את המוצר. נסו שוב.",
    linkReady: "הקישור שלכם מוכן",
    detailsPulled: "הפרטים נשלפו מהחנות",
    youEarnSale: "אתם מרוויחים / מכירה",
    theyEarn: "הם מרוויחים",
    reviewLabel: "הוסיפו המלצה (לא חובה)",
    reviewPlaceholder: "ספרו לחברים למה אתם ממליצים…",
    reviewHint: "החברים יראו את זה כהמלצה אישית שלכם כשיפתחו את הקישור.",
    shareManyNote: "שתפו עם כמה חברים שתרצו — אתם מרוויחים {{amount}} בכל פעם שמישהו מהם קונה.",
    shareManyNoteNoAmount: "שתפו עם כמה חברים שתרצו — אתם מרוויחים קאשבק בכל פעם שמישהו מהם קונה.",
    copy: "העתק",
    copied: "הועתק!",
    share: "שיתוף עם חברים",
    done: "סיום",
    createFailed: "לא הצלחנו ליצור את הקישור. נסו שוב.",
  },
  notFound: {
    title: "הדף לא נמצא",
    message: "הדף שחיפשתם אינו קיים או שהועבר.",
    home: "חזרה לדף הבית",
  },
  error: {
    oops: "אופס",
    title: "משהו השתבש",
    message: "אירעה שגיאה לא צפויה. נסו שוב.",
    retry: "רענון",
    home: "חזרה לדף הבית",
  },
  legal: {
    sampleNotice: "טיוטה לדוגמה — לעיון בלבד, אינה מחייבת.",
    updated: "עודכן לאחרונה: יולי 2026",
    terms: {
      title: "תנאי השימוש",
      sections: [
        {
          h: "1. השירות",
          p: "wanthat מאפשרת לחברים להרוויח קאשבק אמיתי על רכישות שבוצעו דרך קישורי wanthat בחנויות השותפות — ולהרוויח שוב כשחברים קונים דרך קישורים ששיתפו.",
        },
        {
          h: "2. החשבון שלכם",
          p: "חשבון אחד לאדם, מאומת באמצעות מספר טלפון. אתם אחראים לשמירה על הגישה למכשיר ולמספר הטלפון שלכם; קודי התחברות ומפתחות גישה הם אישיים ואין לשתפם.",
        },
        {
          h: "3. קאשבק ומשיכות",
          p: "הקאשבק הופך זמין רק לאחר שהחנות השותפה מאשרת את ההזמנה; הזמנות שבוטלו או הוחזרו מאבדות אותו. סכומים המוצגים ב-₪ לפני האישור הם אומדנים לפי שערי המרה. משיכות מתבצעות לאמצעי התשלום המוצעים באפליקציה.",
        },
        {
          h: "4. שימוש הוגן",
          p: "אין לבצע רכישות עצמיות, המלצות מטעות או שימוש אוטומטי לרעה. אנו רשאים להשעות חשבונות המנסים לנצל את התוכנית ולעכב קאשבק שהושג בניגוד לתנאים.",
        },
        {
          h: "5. שינויים ויצירת קשר",
          p: "אנו עשויים לעדכן תנאים אלה מעת לעת; שינויים מהותיים יוכרזו באפליקציה. שאלות: support@wanthat.app.",
        },
      ],
    },
    privacy: {
      title: "מדיניות הפרטיות",
      sections: [
        {
          h: "1. מה אנחנו אוספים",
          p: "מספר הטלפון, השם, אימייל (לא חובה) והעדפת השפה שלכם; הקישורים שאתם יוצרים, הזמנות המשויכות אליהם ופעילות הארנק שלכם.",
        },
        {
          h: "2. איך אנחנו משתמשים בזה",
          p: "להפעלת תוכנית הקאשבק: אימות באמצעות קוד SMS/וואטסאפ, שיוך הזמנות לקישורים שלכם, חישוב ותשלום קאשבק והצגת הפעילות שלכם באפליקציה.",
        },
        {
          h: "3. שיתוף",
          p: "נתוני הזמנות מוחלפים עם חנויות שותפות ורשתות שותפים אך ורק לאישור רכישות וקאשבק. איננו מוכרים מידע אישי.",
        },
        {
          h: "4. שמירה ואבטחה",
          p: "מידע אישי ותנועות כספים נשמרים מוצפנים, כאשר רשומות כספיות נשמרות ביומן מבוקר, כל עוד החשבון קיים או כנדרש בחוק.",
        },
        {
          h: "5. הזכויות שלכם",
          p: "ניתן לערוך את הפרופיל באפליקציה בכל עת, וליצור קשר לייצוא או מחיקה של נתוני החשבון: support@wanthat.app.",
        },
      ],
    },
  },
};

/** The MEMBER app's translation bundles (the admin console — its own app+origin — carries its own). */
export const resources = { he: { translation: he }, en: { translation: en } } as const;

/** Read a remembered "he"/"en" choice; `fallback` when unset/unavailable (private mode, tests). */
export function storedLanguage(key: string, fallback: "he" | "en" = "he"): "he" | "en" {
  try {
    const stored = localStorage.getItem(key);
    return stored === "en" || stored === "he" ? stored : fallback;
  } catch {
    return fallback;
  }
}

/** Remember a language choice per device; storage failures are silently accepted. */
export function rememberLanguage(key: string, lng: string): void {
  try {
    localStorage.setItem(key, lng.startsWith("he") ? "he" : "en");
  } catch {
    // Storage unavailable (private mode/tests) — the choice simply isn't remembered.
  }
}

// The MEMBER app's language, remembered per device (Hebrew by default) and restored on the next
// visit; once signed in the profile locale takes over (SessionProvider's locale sync). The admin
// console (its own app on its own origin) deliberately does NOT share this key.
const LANG_KEY = "wanthat.lang";

void i18n.use(initReactI18next).init({
  lng: storedLanguage(LANG_KEY),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  resources,
});

// Keep the document direction/lang in sync with the active locale so the layout mirrors (RTL for
// Hebrew, the default; LTR for English). Logical Tailwind properties handle the rest.
applyDocumentLanguage(i18n.language ?? "he");
i18n.on("languageChanged", (lng) => {
  applyDocumentLanguage(lng);
  rememberLanguage(LANG_KEY, lng);
});

export default i18n;
