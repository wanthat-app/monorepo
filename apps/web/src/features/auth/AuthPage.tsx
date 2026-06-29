import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ApiError, authApi } from "../../lib/api";
import { beginPasskeyLogin } from "../../lib/managed-login";
import { passkeysSupported } from "../../lib/passkey";
import { useSession } from "../../lib/session";
import { Button, Card, Logo, Screen, TextField } from "../../ui/components";

type Step = "phone" | "otp" | "register";

/**
 * UC1 Onboard + UC2 Sign-in. One unified phone-OTP flow: a phone that has no profile yet branches to
 * the name step (registration); a known phone signs straight in. A discoverable passkey login is
 * offered up front (Managed Login redirect).
 */
export function AuthPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { signIn } = useSession();

  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [ticket, setTicket] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

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

  const onStart = () =>
    run(async () => {
      const res = await authApi.start(phone);
      setChallengeId(res.challengeId);
      setStep("otp");
    });

  const onVerify = () =>
    run(async () => {
      const res = await authApi.verify(challengeId, code);
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
      const session = await authApi.register({ registrationTicket: ticket, firstName, lastName });
      signIn(session);
      navigate("/home");
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
            <TextField
              name="phone"
              label={t("auth.phoneLabel")}
              type="tel"
              inputMode="tel"
              placeholder="+972 50 000 0000"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              error={error}
            />
            <Button onClick={onStart} loading={busy} disabled={!phone}>
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
            <TextField
              name="code"
              label={t("auth.codeLabel")}
              inputMode="numeric"
              maxLength={6}
              placeholder="······"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              error={error}
            />
            <Button onClick={onVerify} loading={busy} disabled={code.length !== 6}>
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
              error={error}
            />
            <Button onClick={onRegister} loading={busy} disabled={!firstName || !lastName}>
              {t("auth.finish")}
            </Button>
          </>
        )}
      </Card>
    </Screen>
  );
}
