import { normalizePhone, type OtpChannel } from "@wanthat/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  BackButton,
  Button,
  Card,
  Checkbox,
  Logo,
  OtpInput,
  Screen,
  Segmented,
  Spinner,
  TextField,
} from "../../ui";
import {
  biometricLabelKey,
  CognitoError,
  canLoginWithPasskey,
  enrollPasskey,
  hasStoredSession,
  loginWithOtp,
  loginWithPasskey,
  type OtpLoginFlow,
  passkeysSupported,
  resumeSignUp,
  type SignUpFlow,
  signUpWithOtp,
  useSession,
} from "../../user";

type Step = "phone" | "loginOtp" | "register" | "signupOtp" | "face";

const LOCALE_BY_LANG: Record<string, string> = { he: "he-IL", en: "en-US" };
// Cognito code lengths: USER_AUTH SMS_OTP sign-in codes are 8 digits; sign-up confirmation
// codes are 6 (they come from the verification-message pipeline, not the OTP challenge).
const LOGIN_CODE_LENGTH = 8;
const SIGNUP_CODE_LENGTH = 6;

/**
 * UC1 Onboard + UC2 Sign-in — pure consumer of the user module (ADR-0006: the module talks
 * to Cognito directly; no backend participates in authentication). One unified phone-first
 * flow: the phone is tried as a sign-in and Cognito's user-not-found signal branches to
 * registration, where the whole profile (name + email + language + OTP channel + Terms)
 * rides the SignUp call itself, then the confirmation code and a Face ID enrolment step.
 * Where passkeys are supported AND a remembered phone exists, passkey login is auto-armed
 * on focus and offered as a button (userless login is waived — ADR-0006).
 */
// Mock affiliate store — where the acquisition flow lands after auth (the real per-product affiliate
// redirect lands with the full-landing slice). A hardcoded constant, so `?ref` can never open-redirect.
const MOCK_STORE_URL = "https://www.aliexpress.com/";

export function AuthPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { status, loading } = useSession();

  // A `?ref={id}` means the member came from a referral landing — on success send them straight to the
  // store (the acquisition destination), a full navigation out of the SPA. A plain login goes home.
  const referral = searchParams.get("ref") !== null;
  const complete = useCallback(() => {
    if (referral) window.location.assign(MOCK_STORE_URL);
    else navigate("/home", { replace: true });
  }, [referral, navigate]);

  // Already logged in (e.g. a returning member the referral landing routed here) → don't ask them to
  // authenticate again; go straight on once the session has rehydrated.
  useEffect(() => {
    if (status === "signedIn") complete();
  }, [status, complete]);

  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [agreed, setAgreed] = useState(false);
  // OTP channel (ADR-0019): a sticky signup-time preference riding custom:otpChannel. The
  // message-sender is the enforcement point (kill switches + fallback), so the UI only
  // offers the choice — there is no availability endpoint to consult any more.
  const [channel, setChannel] = useState<OtpChannel>("whatsapp");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // The pending Cognito ceremonies (module flow objects) — refs, not state: they carry no UI.
  const loginFlow = useRef<OtpLoginFlow | null>(null);
  const signUpFlow = useRef<SignUpFlow | null>(null);

  const bioLabel = t(`auth.biometric.${biometricLabelKey()}`);
  const armed = useRef(false);

  // Automatic passkey login (ADR-0006): armed once per mount, ONLY when this device remembers
  // a phone (Cognito's WEB_AUTHN challenge is username-gated — userless login is waived). The
  // module waits for document focus internally (iOS rejects an unfocused ceremony), so this
  // fires right after load or at worst on the member's first tap. Cancel/failure quietly
  // leaves the OTP form in charge.
  useEffect(() => {
    if (armed.current) return;
    armed.current = true;
    // A returning member with a stored session is being rehydrated — the effect above will
    // forward them; don't pop a passkey prompt at someone who's already logged in.
    if (hasStoredSession()) return;
    if (!passkeysSupported() || !canLoginWithPasskey()) return;
    loginWithPasskey()
      .then(complete)
      .catch(() => {
        // cancelled / no passkey — OTP and the manual button remain.
      });
  }, [complete]);

  // The country affordance is IL (+972); the field carries the local part. Normalize + validate to
  // E.164 (null until it's a valid number); Cognito re-validates the attribute server-side.
  const e164 = normalizePhone(phone, "IL");
  const lang = i18n.language.startsWith("he") ? "he" : "en";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(
        err instanceof CognitoError
          ? t(`auth.errors.${err.code}`, t("auth.errors.generic"))
          : t("auth.errors.generic"),
      );
    } finally {
      setBusy(false);
    }
  };

  const goToOtp = (next: Extract<Step, "loginOtp" | "signupOtp">) => {
    setCode("");
    setStep(next);
  };

  // The unified branch (ADR-0006): try the phone as a sign-in; user-not-found → registration;
  // an abandoned sign-up (unconfirmed phone) → re-send the confirmation code and resume it.
  const onSubmitPhone = () =>
    run(async () => {
      if (!e164) return; // guarded by the disabled button, but narrows the type
      try {
        loginFlow.current = await loginWithOtp(e164);
        goToOtp("loginOtp");
      } catch (err) {
        if (err instanceof CognitoError && err.code === "user_not_found") {
          setStep("register");
          return;
        }
        if (err instanceof CognitoError && err.code === "user_not_confirmed") {
          signUpFlow.current = await resumeSignUp(e164);
          goToOtp("signupOtp");
          return;
        }
        throw err;
      }
    });

  const onPasskeyLogin = () =>
    run(async () => {
      await loginWithPasskey();
      complete();
    });

  const onVerifyLogin = () =>
    run(async () => {
      await loginFlow.current?.submit(code);
      complete();
    });

  // Registration IS SignUp (ADR-0006): the profile rides UserAttributes; Cognito then sends
  // the confirmation code via the chosen channel.
  const onRegister = () =>
    run(async () => {
      if (!e164) return;
      try {
        signUpFlow.current = await signUpWithOtp({
          phone: e164,
          firstName,
          lastName,
          ...(email ? { email } : {}),
          locale: LOCALE_BY_LANG[lang] ?? "he-IL",
          otpChannel: channel,
        });
      } catch (err) {
        // A prior SignUp for this phone already exists (e.g. the member went Back and
        // resubmitted): the account is sitting UNCONFIRMED — resume its confirmation
        // rather than dead-ending on "already registered".
        if (err instanceof CognitoError && err.code === "phone_exists") {
          signUpFlow.current = await resumeSignUp(e164);
        } else {
          throw err;
        }
      }
      goToOtp("signupOtp");
    });

  const onVerifySignup = () =>
    run(async () => {
      const outcome = await signUpFlow.current?.confirm(code);
      if (outcome === "loginRequired") {
        // Confirmed, but Cognito declined the seamless continuation — fall back to a normal
        // OTP sign-in (sends a fresh code).
        if (e164) loginFlow.current = await loginWithOtp(e164);
        goToOtp("loginOtp");
        return;
      }
      // Offer Face ID enrolment as its own step (only where passkeys are possible), then land home.
      if (passkeysSupported()) setStep("face");
      else complete();
    });

  const onEnableFace = () =>
    run(async () => {
      await enrollPasskey();
      complete();
    });

  // Rehydrating a returning member's session — show a spinner (not the login form) until it resolves,
  // then the effect above forwards them. `loading` is only true while a stored session is refreshing.
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <Screen>
      <div className="flex flex-col items-center gap-2">
        <Logo />
        <p className="text-muted">{t("auth.tagline")}</p>
      </div>

      <Card className="flex flex-col gap-4">
        {step === "phone" && (
          <>
            <div className="flex flex-col gap-3">
              <h1 className="text-[30px] leading-[1.12] tracking-[-0.03em]">{t("auth.heading")}</h1>
              <p className="text-[15px] leading-normal text-muted">{t("auth.subheading")}</p>
            </div>
            {/* Manual passkey button — only where passkeys are supported AND a phone is
                remembered (the native WEB_AUTHN challenge is username-gated, ADR-0006). A
                cancelled auto-prompt lands here; one tap re-opens the OS sheet. */}
            {passkeysSupported() && canLoginWithPasskey() && (
              <Button onClick={onPasskeyLogin} loading={busy}>
                {t("auth.passkeyCta", { label: bioLabel })}
              </Button>
            )}
            <label htmlFor="phone" className="block">
              <span className="mb-1.5 block text-sm font-medium text-muted">
                {t("auth.phoneLabel")}
              </span>
              <div dir="ltr" className="flex gap-2">
                <span className="inline-flex h-12 shrink-0 items-center gap-1.5 rounded-input border border-line bg-surface px-3.5 font-medium text-ink">
                  🇮🇱 +972
                </span>
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="50 123 4567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={`h-12 w-full rounded-input border bg-surface px-4 text-ink outline-none transition focus:border-accent ${
                    error ? "border-rejected" : "border-line"
                  }`}
                />
              </div>
              {error ? <span className="mt-1 block text-sm text-rejected">{error}</span> : null}
            </label>
            <Button onClick={onSubmitPhone} loading={busy} disabled={!e164}>
              {t("auth.continue")}
            </Button>
          </>
        )}

        {step === "loginOtp" && (
          <>
            <div>
              <BackButton onClick={() => setStep("phone")} label={t("auth.back")} />
            </div>
            <p className="text-[15px] leading-normal text-muted">{t("auth.sentCode")}</p>
            <OtpInput
              name="code"
              label={t("auth.codeLabel")}
              value={code}
              onChange={setCode}
              error={error}
              maxLength={LOGIN_CODE_LENGTH}
            />
            <Button
              onClick={onVerifyLogin}
              loading={busy}
              disabled={code.length !== LOGIN_CODE_LENGTH}
            >
              {t("auth.verify")}
            </Button>
            <Button variant="ghost" onClick={() => run(async () => loginFlow.current?.resend())}>
              {t("auth.resend")}
            </Button>
          </>
        )}

        {step === "register" && (
          <>
            <div>
              <BackButton onClick={() => setStep("phone")} label={t("auth.back")} />
            </div>
            <div className="flex flex-col gap-1">
              <h1 className="text-[27px] tracking-[-0.03em]">{t("auth.registerTitle")}</h1>
              <p className="text-[15px] leading-normal text-muted">{t("auth.registerSubtitle")}</p>
            </div>
            <TextField
              name="firstName"
              label={t("auth.firstName")}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
            <TextField
              name="lastName"
              label={t("auth.lastName")}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
            <TextField
              name="email"
              type="email"
              dir="ltr"
              label={t("auth.email")}
              placeholder={t("auth.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={error}
            />
            <div>
              <span className="mb-1.5 block text-sm font-medium text-muted">
                {t("auth.language")}
              </span>
              <Segmented
                value={lang}
                onChange={(value) => void i18n.changeLanguage(value)}
                options={[
                  { value: "en", label: "English" },
                  { value: "he", label: "עברית" },
                ]}
              />
            </div>
            <div>
              <span className="mb-1.5 block text-sm font-medium text-muted">
                {t("auth.channelLabel")}
              </span>
              <Segmented
                value={channel}
                onChange={(value) => setChannel(value as OtpChannel)}
                options={[
                  { value: "whatsapp", label: t("auth.channel.whatsapp") },
                  { value: "sms", label: t("auth.channel.sms") },
                ]}
              />
            </div>
            <Checkbox id="agree-terms" checked={agreed} onChange={setAgreed}>
              {t("auth.agreePre")}{" "}
              <a
                href="https://wanthat.co.il/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-accent underline"
              >
                {t("auth.terms")}
              </a>{" "}
              {t("auth.and")}{" "}
              <a
                href="https://wanthat.co.il/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-accent underline"
              >
                {t("auth.privacy")}
              </a>
            </Checkbox>
            <Button
              onClick={onRegister}
              loading={busy}
              disabled={!firstName || !lastName || !agreed}
            >
              {t("auth.continue")}
            </Button>
          </>
        )}

        {step === "signupOtp" && (
          <>
            <div>
              <BackButton onClick={() => setStep("register")} label={t("auth.back")} />
            </div>
            <p className="text-[15px] leading-normal text-muted">{t(`auth.sentVia.${channel}`)}</p>
            <OtpInput
              name="code"
              label={t("auth.codeLabel")}
              value={code}
              onChange={setCode}
              error={error}
              maxLength={SIGNUP_CODE_LENGTH}
            />
            <Button
              onClick={onVerifySignup}
              loading={busy}
              disabled={code.length !== SIGNUP_CODE_LENGTH}
            >
              {t("auth.verify")}
            </Button>
            <Button variant="ghost" onClick={() => run(async () => signUpFlow.current?.resend())}>
              {t("auth.resend")}
            </Button>
          </>
        )}

        {step === "face" && (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-24 w-24 items-center justify-center rounded-3xl border border-line bg-accent-soft">
              <svg
                width="46"
                height="46"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#1f7a57"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <title>Face ID</title>
                <path d="M4 8V6a2 2 0 0 1 2-2h2" />
                <path d="M16 4h2a2 2 0 0 1 2 2v2" />
                <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
                <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
                <path d="M9 10.5v.5M15 10.5v.5" />
                <path d="M9.5 15a3.5 3.5 0 0 0 5 0" />
              </svg>
            </div>
            <h1 className="text-[25px] tracking-[-0.02em]">{t("auth.face.title")}</h1>
            <p className="text-[15px] leading-normal text-muted">{t("auth.face.subtitle")}</p>
            {error ? <p className="text-sm text-rejected">{error}</p> : null}
            <div className="flex w-full flex-col gap-2">
              <Button onClick={onEnableFace} loading={busy}>
                {t("auth.face.enable")}
              </Button>
              <Button variant="ghost" onClick={complete}>
                {t("auth.face.skip")}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </Screen>
  );
}
