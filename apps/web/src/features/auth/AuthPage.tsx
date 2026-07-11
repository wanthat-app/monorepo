import { normalizePhone, type OtpChannel } from "@wanthat/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { fetchOtpChannelOptions, type OtpChannelOptions } from "../../lib/otp-channels";
import {
  BackButton,
  Button,
  Checkbox,
  LockIcon,
  OtpInput,
  Screen,
  Segmented,
  Spinner,
  TextField,
} from "../../ui";
import {
  BiometricGlyph,
  biometricLabelKey,
  CognitoError,
  clearPendingOtp,
  enrollPasskey,
  hasPendingOtp,
  hasStoredSession,
  loginWithDiscoveredPasskey,
  loginWithOtp,
  loginWithPasskey,
  type OtpLoginFlow,
  passkeyLoginAvailable,
  passkeysSupported,
  rememberedPhone,
  resumePendingOtp,
  resumeSignUp,
  type SignUpFlow,
  signUpWithOtp,
  useSession,
} from "../../user";
import { AppHeader } from "../shell/AppHeader";

type Step = "phone" | "loginOtp" | "register" | "signupOtp" | "face";

const LOCALE_BY_LANG: Record<string, string> = { he: "he-IL", en: "en-US" };
// Cognito code lengths: USER_AUTH SMS_OTP sign-in codes are 8 digits; sign-up confirmation
// codes are 6 (they come from the verification-message pipeline, not the OTP challenge).
const LOGIN_CODE_LENGTH = 8;
const SIGNUP_CODE_LENGTH = 6;
// Resend cooldown (design: OTP screen counts down before offering a resend).
const RESEND_COOLDOWN_S = 30;

const formatCountdown = (s: number) => `0:${String(s).padStart(2, "0")}`;

/**
 * UC1 Onboard + UC2 Sign-in — pure consumer of the user module (ADR-0006: the module talks
 * to Cognito directly; no backend participates in authentication). One unified phone-first
 * flow: the phone is tried as a sign-in and Cognito's user-not-found signal branches to
 * registration, where the whole profile (name + email + language + OTP channel + Terms)
 * rides the SignUp call itself, then the confirmation code and a biometric enrolment step
 * (device-matched Face ID / Touch ID label + glyph). The offered OTP channels mirror the
 * admin kill switches via the public config endpoint (SMS-only when it is unreachable).
 * Passkey gating is COGNITO'S truth, not a local flag (`AvailableChallenges`): with a
 * remembered phone whose account has a passkey, login is auto-armed on focus AND offered as
 * a square icon button beside Continue; with no remembered phone, a conditional-UI (autofill)
 * discovery is armed instead — the browser surfaces the passkey in the phone field iff one
 * exists on this device — and typing a phone re-checks availability to light the button.
 * A failed/cancelled ceremony falls back to the OTP form with friendly guidance and keeps
 * the button; native userless login remains waived (ADR-0006).
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
  // offered channels + the preselected default mirror the kill switches via the PUBLIC config
  // endpoint (same predicate the message-sender enforces, minus the private phoneNumberId);
  // SMS is the safe initial value in case the fetch never lands. The sender remains the
  // enforcement point either way.
  const [channel, setChannel] = useState<OtpChannel>("sms");
  const [channelOptions, setChannelOptions] = useState<OtpChannelOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Friendly (non-alarming) guidance after a failed biometric ceremony — steers to the OTP form.
  const [notice, setNotice] = useState<string | undefined>();
  // Whether the biometric button shows — Cognito's answer (passkeyLoginAvailable), resolved
  // async: for the remembered phone on mount, or for a typed phone via the debounced check.
  // A cancelled ceremony changes nothing (the gate is server truth), so the button always
  // survives a dismissed sheet — the member can re-open the OS prompt instead of OTP.
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  // Seconds until a resend is offered on the OTP steps (reset on every send).
  const [resendLeft, setResendLeft] = useState(0);

  // The pending Cognito ceremonies (module flow objects) — refs, not state: they carry no UI.
  const loginFlow = useRef<OtpLoginFlow | null>(null);
  const signUpFlow = useRef<SignUpFlow | null>(null);
  // Pending conditional-UI discovery (no-remembered-phone path) — aborted before any modal
  // ceremony (one WebAuthn request at a time) and on unmount.
  const discovery = useRef<AbortController | null>(null);

  const bioLabel = t(`auth.biometric.${biometricLabelKey()}`);
  const armed = useRef(false);

  // Kill-switch-aware channel options, fetched once per mount (a registration may follow the
  // phone step within seconds — prefetching hides the latency). Failure resolves SMS-only
  // inside the fetcher, so the chooser degrades gracefully instead of offering WhatsApp blind.
  useEffect(() => {
    let cancelled = false;
    void fetchOtpChannelOptions().then((options) => {
      if (cancelled) return;
      setChannelOptions(options);
      setChannel(options.defaultChannel);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reload survival: a pending OTP challenge persisted by the user module (sessionStorage,
  // TTL = the code's server-side validity) puts the member straight back on the code screen.
  // The use case: switching apps to copy the code and the mobile browser reloading the tab
  // on return. A login flow resumes on the SAME session — nothing is re-sent.
  const restoredPending = useRef(false);
  useEffect(() => {
    if (restoredPending.current) return;
    restoredPending.current = true;
    if (hasStoredSession()) return; // a signed-in rehydration forwards home instead
    const resumed = resumePendingOtp();
    if (!resumed) return;
    setPhone(resumed.phone);
    setCode("");
    setResendLeft(RESEND_COOLDOWN_S);
    if (resumed.kind === "login") {
      loginFlow.current = resumed.flow;
      setStep("loginOtp");
    } else {
      signUpFlow.current = resumed.flow;
      setStep("signupOtp");
    }
  }, []);

  // Automatic passkey login (ADR-0006): armed once per mount, ONLY when this device remembers
  // a phone (Cognito's WEB_AUTHN challenge is username-gated) AND Cognito confirms the account
  // has a passkey (AvailableChallenges — server truth, sends nothing). The module waits for
  // document focus internally (iOS rejects an unfocused ceremony), so this fires right after
  // load or at worst on the member's first tap. Cancel/failure leaves the OTP form in charge
  // with a gentle pointer at it; the button stays — the gate is Cognito's answer, which a
  // dismissed sheet cannot change.
  useEffect(() => {
    if (armed.current) return;
    armed.current = true;
    // A returning member with a stored session is being rehydrated — the effect above will
    // forward them; don't pop a passkey prompt at someone who's already logged in. Same for
    // a restored mid-OTP challenge: they're validating a code, not starting a sign-in.
    if (hasStoredSession() || hasPendingOtp()) return;
    if (!passkeysSupported() || !rememberedPhone()) return;
    void passkeyLoginAvailable().then((available) => {
      if (!available) return;
      setPasskeyAvailable(true);
      loginWithPasskey()
        .then(complete)
        .catch(() => setNotice(t("auth.passkeyFallback")));
    });
  }, [complete, t]);

  // No remembered phone: arm conditional-UI (autofill) discovery instead — the browser shows
  // this site's passkey in the phone field's autofill IFF one exists on this device (the only
  // way the platform exposes "a passkey exists here"); picking it discovers the account and
  // signs in (discovery pick + the real Cognito ceremony — two verifications, once; the
  // sign-in stores the phone so later visits take the single-prompt path above). Re-armed per
  // mount, aborted on unmount — never armed alongside the modal auto-prompt (one pending
  // WebAuthn request at a time).
  useEffect(() => {
    if (hasStoredSession() || hasPendingOtp() || rememberedPhone() || !passkeysSupported()) return;
    const controller = new AbortController();
    discovery.current = controller;
    loginWithDiscoveredPasskey(controller.signal)
      .then((signedIn) => {
        if (signedIn) complete();
      })
      .catch(() => setNotice(t("auth.passkeyFallback")));
    return () => controller.abort();
  }, [complete, t]);

  // The country affordance is IL (+972); the field carries the local part. Normalize + validate to
  // E.164 (null until it's a valid number); Cognito re-validates the attribute server-side.
  const e164 = normalizePhone(phone, "IL");

  // Typed-phone availability check (debounced): a member on a wiped device who types their
  // number gets the biometric button lit before any code is sent — covers browsers without
  // conditional UI. Never un-lights: a shown button stays tappable.
  useEffect(() => {
    if (passkeyAvailable || !e164 || !passkeysSupported()) return;
    const timer = setTimeout(() => {
      void passkeyLoginAvailable(e164).then((available) => {
        if (available) setPasskeyAvailable(true);
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [e164, passkeyAvailable]);
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
    setResendLeft(RESEND_COOLDOWN_S);
    setStep(next);
  };

  // Tick the resend countdown (re-armed per second; stops at zero).
  useEffect(() => {
    if (resendLeft <= 0) return;
    const timer = setTimeout(() => setResendLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendLeft]);

  const onResend = () =>
    run(async () => {
      await (step === "loginOtp" ? loginFlow : signUpFlow).current?.resend();
      setResendLeft(RESEND_COOLDOWN_S);
    });

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

  // Deliberately NOT run(): a biometric failure must fall back to the OTP flow with friendly
  // guidance, not surface as a red error on the phone field. A typed number wins over the
  // remembered one (the member may be signing into a different account); the pending autofill
  // discovery is aborted first — the platform allows one WebAuthn request at a time.
  const onPasskeyLogin = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    discovery.current?.abort();
    try {
      await loginWithPasskey(e164 ? { phone: e164 } : undefined);
      complete();
    } catch {
      setNotice(t("auth.passkeyFallback"));
    } finally {
      setBusy(false);
    }
  };

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

  const codeLength = step === "signupOtp" ? SIGNUP_CODE_LENGTH : LOGIN_CODE_LENGTH;
  // The OTP screen names the number the code went to (design) — E.164 with a space after
  // the country code so it reads naturally.
  const displayPhone = e164 ? e164.replace("+972", "+972 ") : "";

  return (
    <Screen>
      <div className="flex flex-col">
        {step === "phone" && (
          <>
            <div className="mb-5">
              <AppHeader />
            </div>
            {/* Back to the app landing at `/` — except for referral arrivals, whose landing
                was the /p/:id product pitch, not the generic one. */}
            {!referral && (
              <div className="mb-5">
                <BackButton onClick={() => navigate("/")} label={t("auth.back")} />
              </div>
            )}
            <h1 className="mb-3 mt-4 text-[30px] font-bold leading-[1.12] tracking-[-0.03em]">
              {t("auth.heading")}
            </h1>
            <p className="mb-7 text-[15px] leading-normal text-secondary">{t("auth.subheading")}</p>
            <label htmlFor="phone" className="block">
              <span className="mb-2 block text-[13px] font-semibold text-secondary">
                {t("auth.phoneLabel")}
              </span>
              <div dir="ltr" className="flex gap-2">
                <span className="inline-flex h-12 shrink-0 items-center gap-1.5 rounded-field border border-edge bg-surface px-3.5 text-[15px] font-semibold text-ink">
                  🇮🇱 +972
                </span>
                {/* "webauthn" in autocomplete opts this field into conditional-UI passkey
                    autofill: the browser lists the site's passkey here iff one exists. */}
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel webauthn"
                  placeholder="50 123 4567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={`h-12 w-full rounded-field border bg-surface px-4 text-[15px] font-medium text-ink outline-none transition placeholder:text-placeholder focus:border-accent ${
                    error ? "border-rejected" : "border-edge"
                  }`}
                />
              </div>
              {error ? <span className="mt-1 block text-sm text-rejected">{error}</span> : null}
            </label>
            {notice ? <p className="mt-3 text-sm text-muted">{notice}</p> : null}
            <div className="mt-3.5">
              <Button onClick={onSubmitPhone} loading={busy} disabled={!e164}>
                {t("auth.phoneCta")}
              </Button>
            </div>
            <p className="mx-1 mt-3.5 text-center text-xs leading-normal text-subtle">
              {t("auth.phoneHelper")}
            </p>
            {/* Manual biometric login — the square icon button at the bottom of the screen
                (FaceID / fingerprint glyph via the device-match logic), shown when Cognito
                confirms the account (remembered or typed phone) has a passkey. A cancelled
                auto-prompt lands here; one tap re-opens the OS sheet. */}
            {passkeyAvailable && (
              <div className="mt-8 flex justify-center">
                <button
                  type="button"
                  onClick={() => void onPasskeyLogin()}
                  disabled={busy}
                  aria-label={t("auth.passkeyCta", { label: bioLabel })}
                  title={t("auth.passkeyCta", { label: bioLabel })}
                  className="flex h-20 w-20 shrink-0 items-center justify-center rounded-chip border border-edge bg-surface text-accent transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <BiometricGlyph size={42} strokeWidth={1.7} />
                </button>
              </div>
            )}
          </>
        )}

        {(step === "loginOtp" || step === "signupOtp") && (
          <>
            <div className="mb-7">
              {/* Backing out abandons the challenge — clear it so a later reload doesn't
                  resurrect an OTP screen the member deliberately left. */}
              <BackButton
                onClick={() => {
                  clearPendingOtp();
                  setStep(step === "loginOtp" ? "phone" : "register");
                }}
                label={t("auth.back")}
              />
            </div>
            <h1 className="mb-2.5 text-[27px] font-bold tracking-[-0.03em]">
              {t("auth.otpTitle")}
            </h1>
            <p className="mb-7 text-[15px] leading-normal text-secondary">
              {t("auth.otpSent", { digits: codeLength })}{" "}
              <span className="tabular font-bold text-ink">{displayPhone}</span>
            </p>
            <OtpInput
              name="code"
              label={t("auth.codeLabel")}
              value={code}
              onChange={setCode}
              error={error}
              maxLength={codeLength}
              placeholder={"–".repeat(codeLength)}
            />
            <div className="mt-5">
              <Button
                onClick={step === "loginOtp" ? onVerifyLogin : onVerifySignup}
                loading={busy}
                disabled={code.length !== codeLength}
              >
                {t("auth.verify")}
              </Button>
            </div>
            <p className="mt-5 text-center text-sm text-secondary">
              {t("auth.resendPre")}{" "}
              {resendLeft > 0 ? (
                <span className="tabular font-bold text-accent">
                  {t("auth.resendIn", { time: formatCountdown(resendLeft) })}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={onResend}
                  disabled={busy}
                  className="font-bold text-accent disabled:opacity-60"
                >
                  {t("auth.resend")}
                </button>
              )}
            </p>
            {/* Reassurance chip (design): codes are skippable once a passkey exists. */}
            {passkeysSupported() && (
              <div className="mt-8 flex items-center gap-3 rounded-chip border border-accent-border bg-accent-soft px-4 py-3.5">
                <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-accent text-white">
                  <LockIcon />
                </span>
                <span>
                  <span className="block text-[13.5px] font-bold text-ink">
                    {t("auth.skipCodes")}
                  </span>
                  <span className="block text-[12.5px] text-secondary">
                    {t("auth.skipCodesSub")}
                  </span>
                </span>
              </div>
            )}
          </>
        )}

        {step === "register" && (
          <>
            <div className="mb-6">
              <BackButton onClick={() => setStep("phone")} label={t("auth.back")} />
            </div>
            <h1 className="mb-2 text-[27px] font-bold tracking-[-0.03em]">
              {t("auth.registerTitle")}
            </h1>
            <p className="mb-6 text-[15px] leading-normal text-secondary">
              {t("auth.registerSubtitle")}
            </p>
            <div className="flex flex-col gap-3.5">
              <div className="flex gap-2.5">
                <div className="min-w-0 flex-1">
                  <TextField
                    name="firstName"
                    label={t("auth.firstName")}
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <TextField
                    name="lastName"
                    label={t("auth.lastName")}
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </div>
              </div>
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
                <span className="mb-1.5 block text-[13px] font-semibold text-secondary">
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
              {/* Channel chooser only when there is an actual choice: the options mirror the
                admin kill switches (public config endpoint; SMS-only when the fetch failed),
                so a disabled channel is never offered and a single channel needs no UI. */}
              {channelOptions && channelOptions.channels.length > 1 && (
                <div>
                  <span className="mb-1.5 block text-[13px] font-semibold text-secondary">
                    {t("auth.channelLabel")}
                  </span>
                  <Segmented
                    value={channel}
                    onChange={(value) => setChannel(value as OtpChannel)}
                    options={channelOptions.channels.map((c) => ({
                      value: c,
                      label: t(`auth.channel.${c}`),
                    }))}
                  />
                </div>
              )}
              <Checkbox id="agree-terms" checked={agreed} onChange={setAgreed}>
                {t("auth.agreePre")}{" "}
                {/* New tab on purpose: same-tab navigation would drop the filled form. */}
                <a
                  href="/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-accent underline"
                >
                  {t("auth.terms")}
                </a>{" "}
                {t("auth.and")}{" "}
                <a
                  href="/privacy"
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
            </div>
          </>
        )}

        {/* Post-registration enrolment step: device-matched label + glyph (Face ID on iPhone,
            fingerprint elsewhere); Skip is one tap and goes straight home. Only rendered where
            passkeysSupported() (see onVerifySignup). */}
        {step === "face" && (
          <div className="flex flex-col items-center gap-4 pt-6 text-center">
            <div className="flex h-24 w-24 items-center justify-center rounded-3xl border border-line bg-accent-soft text-accent">
              <BiometricGlyph size={46} strokeWidth={1.7} />
            </div>
            <h1 className="text-[25px] tracking-[-0.02em]">
              {t("auth.face.title", { label: bioLabel })}
            </h1>
            <p className="text-[15px] leading-normal text-muted">{t("auth.face.subtitle")}</p>
            {error ? <p className="text-sm text-rejected">{error}</p> : null}
            <div className="flex w-full flex-col gap-2">
              <Button onClick={onEnableFace} loading={busy}>
                {t("auth.face.enable", { label: bioLabel })}
              </Button>
              <Button variant="ghost" onClick={complete}>
                {t("auth.face.skip")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Screen>
  );
}
