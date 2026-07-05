import { normalizePhone, type OtpChannel } from "@wanthat/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ApiError, authApi } from "../../lib/api";
import {
  biometricLabelKey,
  deviceHasPasskey,
  enrollPasskey,
  loginWithPasskey,
  loginWithPasskeyAutofill,
  markPasskeyDevice,
  passkeyAutofillSupported,
  passkeysSupported,
} from "../../lib/passkey";
import { useSession } from "../../lib/session";
import {
  BackButton,
  Button,
  Card,
  Checkbox,
  Logo,
  OtpInput,
  Screen,
  Segmented,
  TextField,
} from "../../ui/components";

type Step = "phone" | "otp" | "register" | "face";

const LOCALE_BY_LANG: Record<string, string> = { he: "he-IL", en: "en-US" };

/**
 * UC1 Onboard + UC2 Sign-in. One unified phone-OTP flow: a phone that has no profile yet branches to
 * the registration step (name + email + language + Terms), then a Face ID enrolment step; a known
 * phone signs straight in. Wherever this browser supports passkeys (ADR-0024), a userless
 * discoverable passkey login button is offered up front, above the phone form — the OS shows a
 * modal picker of the member's passkeys for this origin; OTP is always the fallback.
 */
export function AuthPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { signIn, accessToken } = useSession();

  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [challengeId, setChallengeId] = useState("");
  const [ticket, setTicket] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Channel choice (ADR-0023): the UI owns the default and the recovery path. Availability comes
  // from /auth/config; until (or unless) it loads, sms-only keeps the flow working.
  const [channels, setChannels] = useState<OtpChannel[]>(["sms"]);
  const [channel, setChannel] = useState<OtpChannel>("sms");
  const [errorCode, setErrorCode] = useState<string | undefined>();

  const bioLabel = t(`auth.biometric.${biometricLabelKey()}`);

  // Passkey login affordance (ADR-0024). `autofillSupported` is null while we probe conditional-UI
  // support (used only for first-time devices). `autoTried` flips true after an auto-modal prompt was
  // fired and did NOT sign the member in (cancelled / no passkey) — then we surface the manual button.
  const [autofillSupported, setAutofillSupported] = useState<boolean | null>(null);
  const [autoTried, setAutoTried] = useState(false);
  const armed = useRef(false);

  useEffect(() => {
    void authApi
      .config()
      .then((cfg) => {
        setChannels(cfg.channels);
        if (cfg.defaultChannel) setChannel(cfg.defaultChannel);
      })
      .catch(() => {}); // advisory only — the server re-checks on /auth/start
  }, []);

  // Passkey login on load (ADR-0024). Two regimes, chosen once per mount:
  //  - Returning passkey device → fire an AUTOMATIC modal prompt: the Face ID sheet pops with no tap
  //    (iOS 16 spends its one gesture-free get() here; iOS 17.4+ has no gesture limit). This is the
  //    fully-automatic path. On cancel/no-passkey we fall back to the manual button.
  //  - First-time device → the gentle conditional-UI autofill (the passkey offers itself in the field);
  //    using it marks the device so the NEXT visit gets the automatic prompt.
  // The passkey ceremony must be the first async op on load (Safari allows only one), so nothing is
  // awaited before it. Guarded so it runs exactly once.
  useEffect(() => {
    if (armed.current) return;
    armed.current = true;
    if (!passkeysSupported()) {
      setAutofillSupported(false);
      return;
    }
    void (async () => {
      if (deviceHasPasskey()) {
        try {
          const session = await loginWithPasskey(); // modal; auto-prompts on load
          markPasskeyDevice();
          signIn(session);
          navigate("/home", { replace: true });
          return;
        } catch {
          setAutoTried(true); // cancelled / no passkey → show the manual button (freebie is spent)
          return;
        }
      }
      const supported = await passkeyAutofillSupported();
      setAutofillSupported(supported);
      if (!supported) return;
      try {
        const session = await loginWithPasskeyAutofill();
        markPasskeyDevice();
        signIn(session);
        navigate("/home", { replace: true });
      } catch {
        // aborted / not used — stay on the form; OTP or the manual button continues.
      }
    })();
  }, [navigate, signIn]);

  // The country affordance is IL (+972); the field carries the local part. Normalize + validate to
  // E.164 (null until it's a valid number); the API re-normalizes defensively. A country picker would
  // just pass a different default here.
  const e164 = normalizePhone(phone, "IL");
  const lang = i18n.language.startsWith("he") ? "he" : "en";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setErrorCode(undefined);
    try {
      await fn();
    } catch (err) {
      setErrorCode(err instanceof ApiError ? err.code : undefined);
      setError(
        err instanceof ApiError
          ? t(`auth.errors.${err.code}`, t("auth.errors.generic"))
          : t("auth.errors.generic"),
      );
    } finally {
      setBusy(false);
    }
  };

  const goHome = () => navigate("/home", { replace: true });

  const onStart = (ch: OtpChannel = channel) =>
    run(async () => {
      if (!e164) return; // guarded by the disabled button, but narrows the type
      const res = await authApi.start(e164, ch, lang);
      setChannel(res.channel);
      setChallengeId(res.challengeId);
      setStep("otp");
    });

  const onPasskeyLogin = () =>
    run(async () => {
      const session = await loginWithPasskey();
      markPasskeyDevice();
      signIn(session);
      navigate("/home", { replace: true });
    });

  const onVerify = () =>
    run(async () => {
      // /auth/verify (app-auth) only hands back a ticket; /auth/session (app-core) resolves it to a
      // login or a registration prompt, since that decision needs Aurora (ADR-0021).
      const { registrationTicket } = await authApi.verify(challengeId, code);
      const res = await authApi.session(registrationTicket);
      if (res.status === "authenticated") {
        signIn(res);
        navigate("/home");
      } else {
        setTicket(res.registrationTicket);
        setStep("register");
      }
    });

  const onRegister = () =>
    run(async () => {
      const session = await authApi.register({
        registrationTicket: ticket,
        firstName,
        lastName,
        ...(email ? { email } : {}),
        locale: LOCALE_BY_LANG[lang],
      });
      signIn(session);
      // Offer Face ID enrolment as its own step (only where passkeys are possible), then land home.
      if (passkeysSupported()) setStep("face");
      else navigate("/home");
    });

  const onEnableFace = () =>
    run(async () => {
      const token = accessToken();
      if (token) await enrollPasskey(token);
      markPasskeyDevice(); // next visit on this device auto-prompts Face ID on load
      goHome();
    });

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
            {/* Manual passkey button — the gesture fallback. Shown after an auto-prompt was cancelled
                (`autoTried`, the iOS-16 freebie is spent so only a tap works now) or where conditional
                UI isn't available. On a returning device the auto-prompt already fired on load; on a
                first-time device the passkey offers itself in the field's autofill instead. */}
            {passkeysSupported() && (autoTried || autofillSupported === false) && (
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
                  // `webauthn` makes this field the conditional-UI autofill target: focusing it surfaces
                  // the member's passkeys for this origin (ADR-0024 Slice 2), armed in the effect above.
                  autoComplete="tel webauthn"
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
            {channels.length > 1 && (
              <div>
                <span className="mb-1.5 block text-sm font-medium text-muted">
                  {t("auth.channelLabel")}
                </span>
                <Segmented
                  value={channel}
                  onChange={(value) => setChannel(value as OtpChannel)}
                  options={channels.map((ch) => ({ value: ch, label: t(`auth.channel.${ch}`) }))}
                />
              </div>
            )}
            <Button onClick={() => onStart()} loading={busy} disabled={!e164}>
              {t("auth.continue")}
            </Button>
            {errorCode &&
              ["send_failed", "channel_disabled"].includes(errorCode) &&
              channel === "whatsapp" &&
              channels.includes("sms") && (
                <Button variant="ghost" onClick={() => onStart("sms")}>
                  {t("auth.trySms")}
                </Button>
              )}
          </>
        )}

        {step === "otp" && (
          <>
            <div>
              <BackButton onClick={() => setStep("phone")} label={t("auth.back")} />
            </div>
            <p className="text-[15px] leading-normal text-muted">{t(`auth.sentVia.${channel}`)}</p>
            <OtpInput
              name="code"
              label={t("auth.codeLabel")}
              value={code}
              onChange={setCode}
              error={error}
              maxLength={8}
            />
            <Button onClick={onVerify} loading={busy} disabled={code.length !== 8}>
              {t("auth.verify")}
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                run(async () => {
                  const r = await authApi.resend(challengeId, channel);
                  setChannel(r.channel);
                })
              }
            >
              {t("auth.resend")}
            </Button>
            {channel === "whatsapp" && channels.includes("sms") && (
              <Button
                variant="ghost"
                onClick={() =>
                  run(async () => {
                    const r = await authApi.resend(challengeId, "sms");
                    setChannel(r.channel);
                  })
                }
              >
                {t("auth.resendSms")}
              </Button>
            )}
          </>
        )}

        {step === "register" && (
          <>
            <div>
              <BackButton onClick={() => setStep("otp")} label={t("auth.back")} />
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
                  { value: "en", label: "EN" },
                  { value: "he", label: "עברית" },
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
              <Button variant="ghost" onClick={goHome}>
                {t("auth.face.skip")}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </Screen>
  );
}
