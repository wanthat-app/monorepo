import { normalizePhone } from "@wanthat/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ApiError, authApi } from "../../lib/api";
import { beginPasskeyLogin } from "../../lib/managed-login";
import { enrollPasskey, passkeysSupported } from "../../lib/passkey";
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
 * phone signs straight in. A discoverable passkey login is offered up front (Managed Login redirect).
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

  // The country affordance is IL (+972); the field carries the local part. Normalize + validate to
  // E.164 (null until it's a valid number); the API re-normalizes defensively. A country picker would
  // just pass a different default here.
  const e164 = normalizePhone(phone, "IL");
  const lang = i18n.language.startsWith("he") ? "he" : "en";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
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

  const onStart = () =>
    run(async () => {
      if (!e164) return; // guarded by the disabled button, but narrows the type
      const res = await authApi.start(e164);
      setChallengeId(res.challengeId);
      setStep("otp");
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
            <Button onClick={onStart} loading={busy} disabled={!e164}>
              {t("auth.continue")}
            </Button>
            {passkeysSupported() && (
              <Button variant="ghost" onClick={() => beginPasskeyLogin()}>
                {t("auth.passkeyLogin")}
              </Button>
            )}
          </>
        )}

        {step === "otp" && (
          <>
            <div>
              <BackButton onClick={() => setStep("phone")} label={t("auth.back")} />
            </div>
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
              onClick={() => run(async () => void (await authApi.resend(challengeId)))}
            >
              {t("auth.resend")}
            </Button>
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
