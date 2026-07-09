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
    emailPlaceholder: "name@email.com",
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
    sentCode: "We sent you a sign-in code.",
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
    estimated: "Estimated", // (design)
    heldNote: "held in original currencies", // (design)
    pendingNote: "≈{{amount}} pending confirmation", // (design, parameterised)
    withdrawCash: "Withdraw cash", // (design: withdrawToBank)
    recentActivity: "Recent activity", // (design)
    seeAll: "See all", // (design)
    noActivity: "No activity yet — cashback from your links will show up here.",
    createLink: "Create link",
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
    },
    turnLinkTitle: "Turn a link into cashback", // (design)
    turnLinkSub: "Paste any AliExpress product and share your reward link.", // (design)
    pastePlaceholder: "Paste product link…", // (design)
  },
  create: {
    title: "Create a link", // (design)
    linkLabel: "AliExpress product link", // (design)
    pastePlaceholder: "Paste product link…", // (design)
    hint: "Paste a link — we'll pull the product automatically.", // (design)
    cta: "Create cashback link", // (design)
    pulling: "Pulling product details…", // (design)
    unsupported: "Only AliExpress product links are supported right now.",
    notConfigured: "Link creation isn't available right now. Please try again later.",
    notSupported:
      "AliExpress doesn't offer cashback on this item, so a link can't be created for it.",
    resolveFailed: "We couldn't pull that product. Please try again.",
    linkReady: "Your link is ready", // (design)
    detailsPulled: "Details pulled from AliExpress", // (design)
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
    language: "Language",
    dashboardSub: "Cashback performance across the platform",
    configSub: "Reward rules, payouts and feature flags",
    usersNav: "Users",
    usersSub: "Search, moderate and remove customer accounts",
    usersPage: {
      searchPlaceholder: "Phone starts with\u2026 (05x or +972)",
      name: "Name",
      phone: "Phone",
      email: "Email",
      status: "Status",
      joined: "Joined",
      actions: "",
      empty: "No users match.",
      loadError: "Couldn't load users.",
      approxTotal: "~{{total}} users",
      loadMore: "Load more",
      loadingMore: "Loading\u2026",
      loadMoreFailed: "Couldn't load more users \u2014 try again.",
      delete: "Delete user",
      confirmDelete: "Delete?",
      confirmYes: "Confirm delete",
      confirmNo: "Cancel",
      deleteFailed: "Delete failed \u2014 try again.",
      deleted: "User deleted.",
      deletedWithRecs: "User deleted \u00b7 {{n}} recommendations removed.",
      suspend: "Suspend user",
      confirmSuspend: "Suspend?",
      suspendNote:
        "Already-issued access tokens keep working for up to 1 hour \u2014 pair with \u201csign out everywhere\u201d for a full kick.",
      suspendedToast: "User suspended. Pair with \u201csign out everywhere\u201d for a full kick.",
      unsuspend: "Unsuspend user",
      confirmUnsuspend: "Unsuspend?",
      unsuspendedToast: "Suspension lifted.",
      signOut: "Sign out everywhere",
      confirmSignOut: "Sign out?",
      signOutNote:
        "Revokes every refresh token; already-issued access tokens keep working for up to 1 hour.",
      signedOutToast: "Signed out everywhere.",
      actionFailed: "Action failed \u2014 try again.",
      notFound: "User not found \u2014 refresh the list.",
      active: "Active",
      suspended: "Suspended",
      unconfirmed: "Unconfirmed",
    },
    activityNav: "Activity",
    activitySub: "Audit log and user activity, newest first",
    activityPage: {
      time: "Time",
      event: "Event",
      user: "User",
      details: "Details",
      empty: "No activity yet.",
      loadError: "Couldn't load activity.",
      retry: "Retry",
      refresh: "Refresh",
      pageOf: "Page {{page}} of {{pages}} · {{total}} events",
      prev: "Previous",
      next: "Next",
      registered: "Registered",
      deleted: "User deleted",
      otpSent: "OTP sent",
      dev: "DEV",
      deletedBy: "by {{actor}}",
      expiresIn: "expires in {{minutes}} min",
      expired: "expired",
    },
    comingSoon: "Coming soon",
    comingSoonHint: "Charts, the approvals queue and top-earning links land in a later slice.",
    loadError: "Failed to load configuration.",
    live: "live",
    stats: {
      users: "Active users",
      pending: "Pending payouts",
      cashback: "Cashback paid",
      conversions: "Link conversion",
      links: "Links created",
      products: "Products",
    },
    users: {
      title: "Users",
      newToday: "New today",
      new7d: "New (7d)",
      new30d: "New (30d)",
      active: "Active",
      suspended: "Suspended",
      signups30d: "Signups (last 30 days)",
      error: "Couldn't load user stats.",
      unavailable:
        "Signup and status metrics aren't available since the move to Cognito — the Users page shows the approximate pool size.",
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
    otpChannel: { whatsapp: "WhatsApp", sms: "SMS" },
    integrations: {
      title: "Integrations",
      desc: "Third-party retailer credentials. Write-only: values can be replaced but never viewed.",
      aliexpressTitle: "AliExpress credentials",
      aliexpressDesc:
        "App key and secret from the AliExpress affiliate console. Saving replaces both.",
      appKey: "AppKey",
      appSecret: "AppSecret",
      configured: "Credentials set — last updated {{date}}",
      notConfigured: "Not configured",
      statusUnknown: "Status unavailable",
      save: "Save credentials",
      saved: "Credentials updated.",
      error: "Failed to update credentials.",
      trackingId: "Tracking ID",
      trackingIdDesc:
        "Sent on every affiliate link and echoed in order reports. Must match a tracking ID that exists in the AliExpress affiliate console.",
      trackingIdSave: "Save tracking ID",
      trackingIdSaved: "Tracking ID updated.",
      trackingIdError: "Failed to update the tracking ID.",
    },
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
      auth_whatsappEnabled: {
        title: "WhatsApp one-time codes",
        desc: "Master switch for OTP delivery over WhatsApp (kill switch; sign-up hides the option while off).",
      },
      auth_smsEnabled: {
        title: "SMS one-time codes",
        desc: "Master switch for SMS OTP sign-in (kill switch during abuse).",
      },
      auth_defaultOtpChannel: {
        title: "Default OTP channel",
        desc: "Preselected code channel for new sign-ups; the sender falls back when it is disabled.",
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
  notFound: {
    title: "Page not found",
    message: "The page you're looking for doesn't exist or has moved.",
    home: "Back to home",
  },
  shared: {
    onMerchant: "on {{merchant}}",
    earnLabel: "You earn back",
    recommendsThis: "{{name}} recommends this",
    sentYouLink: "Someone sent you a cashback link",
    notFoundTitle: "Link not found",
    notFoundBody: "This link may have expired or never existed.",
    pitch: "Buy through wanthat and get real cashback to your wallet once the order confirms.",
    signupCta: "Sign up to earn",
    signupTrust: "Free · takes 30 seconds",
    loginCta: "I already have an account",
    guestCta: "Continue as guest — no cashback",
    signingIn: "Signing you in…",
    goToStore: "Go to store",
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
    emailPlaceholder: "name@email.com",
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
    sentCode: "שלחנו לך קוד כניסה.",
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
    estimated: "משוער",
    heldNote: "מוחזק במטבע המקורי",
    pendingNote: "≈{{amount}} ממתין לאישור",
    withdrawCash: "משיכת מזומן",
    recentActivity: "פעילות אחרונה",
    seeAll: "הצג הכל",
    noActivity: "אין פעילות עדיין — קאשבק מהקישורים שלכם יופיע כאן.",
    createLink: "יצירת קישור",
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
    },
    turnLinkTitle: "הפכו קישור לקאשבק",
    turnLinkSub: "הדביקו מוצר מ-AliExpress ושתפו קישור תגמול.",
    pastePlaceholder: "הדביקו קישור למוצר…",
  },
  create: {
    title: "יצירת קישור",
    linkLabel: "קישור למוצר ב-AliExpress",
    pastePlaceholder: "הדביקו קישור למוצר…",
    hint: "הדביקו קישור — נשלוף את המוצר אוטומטית.",
    cta: "צרו קישור קאשבק",
    pulling: "שולפים פרטי מוצר…",
    unsupported: "כרגע נתמכים רק קישורי מוצר מ-AliExpress.",
    notConfigured: "יצירת קישורים אינה זמינה כרגע. נסו שוב מאוחר יותר.",
    notSupported: "AliExpress אינו מציע קאשבק על מוצר זה, לכן לא ניתן ליצור עבורו קישור.",
    resolveFailed: "לא הצלחנו לשלוף את המוצר. נסו שוב.",
    linkReady: "הקישור שלכם מוכן",
    detailsPulled: "הפרטים נשלפו מ-AliExpress",
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
    language: "שפה",
    dashboardSub: "ביצועי קאשבק ברחבי הפלטפורמה",
    configSub: "כללי תגמול, תשלומים ודגלי תכונות",
    usersNav: "משתמשים",
    usersSub: "חיפוש, ניהול והסרה של חשבונות לקוח",
    usersPage: {
      searchPlaceholder: "טלפון שמתחיל ב… (05x או ‎+972)",
      name: "שם",
      phone: "טלפון",
      email: "אימייל",
      status: "סטטוס",
      joined: "הצטרפות",
      actions: "",
      empty: "אין משתמשים תואמים.",
      loadError: "טעינת המשתמשים נכשלה.",
      approxTotal: "כ־{{total}} משתמשים",
      loadMore: "טעינת עוד",
      loadingMore: "טוען…",
      loadMoreFailed: "טעינת משתמשים נוספים נכשלה — נסו שוב.",
      delete: "מחיקת משתמש",
      confirmDelete: "למחוק?",
      confirmYes: "אישור מחיקה",
      confirmNo: "ביטול",
      deleteFailed: "המחיקה נכשלה \u2014 נסו שוב.",
      deleted: "המשתמש נמחק.",
      deletedWithRecs: "המשתמש נמחק · {{n}} המלצות הוסרו.",
      suspend: "השעיית משתמש",
      confirmSuspend: "להשעות?",
      suspendNote:
        "אסימוני גישה שכבר הונפקו ימשיכו לפעול עד שעה — מומלץ לשלב עם ניתוק מכל המכשירים לחסימה מלאה.",
      suspendedToast: "המשתמש הושעה. מומלץ לשלב עם ניתוק מכל המכשירים לחסימה מלאה.",
      unsuspend: "ביטול השעיה",
      confirmUnsuspend: "לבטל השעיה?",
      unsuspendedToast: "ההשעיה בוטלה.",
      signOut: "ניתוק מכל המכשירים",
      confirmSignOut: "לנתק?",
      signOutNote: "מבטל את כל אסימוני הרענון; אסימוני גישה שכבר הונפקו ימשיכו לפעול עד שעה.",
      signedOutToast: "המשתמש נותק מכל המכשירים.",
      actionFailed: "הפעולה נכשלה — נסו שוב.",
      notFound: "המשתמש לא נמצא — רעננו את הרשימה.",
      active: "פעיל",
      suspended: "מושהה",
      unconfirmed: "לא מאומת",
    },
    activityNav: "פעילות",
    activitySub: "יומן ביקורת ופעילות משתמשים, מהחדש לישן",
    activityPage: {
      time: "זמן",
      event: "אירוע",
      user: "משתמש",
      details: "פרטים",
      empty: "אין פעילות עדיין.",
      loadError: "טעינת הפעילות נכשלה.",
      retry: "נסה שוב",
      refresh: "רענון",
      pageOf: "עמוד {{page}} מתוך {{pages}} · {{total}} אירועים",
      prev: "הקודם",
      next: "הבא",
      registered: "נרשם/ה",
      deleted: "משתמש נמחק",
      otpSent: "קוד נשלח",
      dev: "DEV",
      deletedBy: "על ידי {{actor}}",
      expiresIn: "פג בעוד {{minutes}} דק'",
      expired: "פג תוקף",
    },
    comingSoon: "בקרוב",
    comingSoonHint: "גרפים, תור האישורים והקישורים המרוויחים ביותר יגיעו בשלב מאוחר יותר.",
    loadError: "טעינת התצורה נכשלה.",
    live: "חי",
    stats: {
      users: "משתמשים פעילים",
      pending: "תשלומים ממתינים",
      cashback: "קאשבק ששולם",
      conversions: "המרת קישורים",
      links: "קישורים שנוצרו",
      products: "מוצרים",
    },
    users: {
      title: "משתמשים",
      newToday: "חדשים היום",
      new7d: "חדשים (7 ימים)",
      new30d: "חדשים (30 יום)",
      active: "פעילים",
      suspended: "מושהים",
      signups30d: "הרשמות (30 הימים האחרונים)",
      error: "טעינת נתוני המשתמשים נכשלה.",
      unavailable:
        "מדדי הרשמה וסטטוס אינם זמינים מאז המעבר ל־Cognito — עמוד המשתמשים מציג את גודל המאגר המקורב.",
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
    otpChannel: { whatsapp: "וואטסאפ", sms: "SMS" },
    integrations: {
      title: "אינטגרציות",
      desc: "פרטי גישה לקמעונאים חיצוניים. לכתיבה בלבד: אפשר להחליף את הערכים אך לא לצפות בהם.",
      aliexpressTitle: "פרטי גישה ל-AliExpress",
      aliexpressDesc: "מפתח וסוד האפליקציה מקונסולת השותפים של AliExpress. שמירה מחליפה את שניהם.",
      appKey: "AppKey",
      appSecret: "AppSecret",
      configured: "פרטי הגישה הוגדרו — עודכנו לאחרונה {{date}}",
      notConfigured: "לא הוגדר",
      statusUnknown: "הסטטוס אינו זמין",
      save: "שמירת פרטי גישה",
      saved: "פרטי הגישה עודכנו.",
      error: "עדכון פרטי הגישה נכשל.",
      trackingId: "Tracking ID",
      trackingIdDesc:
        "נשלח בכל קישור שותפים ומוחזר בדוחות ההזמנות. חייב להתאים ל-Tracking ID קיים בקונסולת השותפים של AliExpress.",
      trackingIdSave: "שמירת Tracking ID",
      trackingIdSaved: "ה-Tracking ID עודכן.",
      trackingIdError: "עדכון ה-Tracking ID נכשל.",
    },
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
      auth_whatsappEnabled: {
        title: "קודים חד-פעמיים בוואטסאפ",
        desc: "מתג ראשי לשליחת קודים בוואטסאפ (מנגנון נטרול; כשהוא כבוי ההרשמה מסתירה את האפשרות).",
      },
      auth_smsEnabled: {
        title: "קודי SMS חד-פעמיים",
        desc: "מתג ראשי לכניסה עם קוד SMS (מנגנון נטרול בעת ניצול לרעה).",
      },
      auth_defaultOtpChannel: {
        title: "ערוץ קוד ברירת מחדל",
        desc: "הערוץ שנבחר מראש לנרשמים חדשים; השולח עובר לערוץ אחר כשהוא מנוטרל.",
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
  notFound: {
    title: "הדף לא נמצא",
    message: "הדף שחיפשתם אינו קיים או שהועבר.",
    home: "חזרה לדף הבית",
  },
  shared: {
    onMerchant: "ב-{{merchant}}",
    earnLabel: "מקבלים בחזרה",
    recommendsThis: "{{name}} ממליץ/ה על זה",
    sentYouLink: "מישהו שלח לך קישור קאשבק",
    notFoundTitle: "הקישור לא נמצא",
    notFoundBody: "ייתכן שהקישור פג תוקף או שאינו קיים.",
    pitch: "קונים דרך wanthat ומקבלים קאשבק אמיתי לארנק כשהעסקה מאושרת.",
    signupCta: "הרשמה וקבלת קאשבק",
    signupTrust: "חינם לגמרי · הצטרפות ב-30 שניות",
    loginCta: "כבר יש לי חשבון",
    guestCta: "המשך כאורח — בלי קאשבק",
    signingIn: "מחברים אתכם…",
    goToStore: "מעבר לחנות",
  },
};

// The chosen language is remembered per device (Hebrew by default) and restored on the next visit.
// Guarded so the module stays importable outside the browser (tests, SSR).
const LANG_KEY = "wanthat.lang";

function storedLanguage(): "he" | "en" {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    return stored === "en" || stored === "he" ? stored : "he";
  } catch {
    return "he";
  }
}

void i18n.use(initReactI18next).init({
  lng: typeof localStorage === "undefined" ? "he" : storedLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  resources: { he: { translation: he }, en: { translation: en } },
});

// Keep the document direction/lang in sync with the active locale so the layout mirrors (RTL for
// Hebrew, the default; LTR for English). Logical Tailwind properties handle the rest.
function applyDir(lng: string) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lng;
  document.documentElement.dir = lng.startsWith("he") ? "rtl" : "ltr";
}
applyDir(i18n.language ?? "he");
i18n.on("languageChanged", (lng) => {
  applyDir(lng);
  try {
    localStorage.setItem(LANG_KEY, lng.startsWith("he") ? "he" : "en");
  } catch {
    // Storage unavailable (private mode/tests) — the choice simply isn't remembered.
  }
});

export default i18n;
