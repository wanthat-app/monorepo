import type { OtpChannel } from "@wanthat/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchOtpChannelOptions, type OtpChannelOptions } from "../lib/otp-channels";
import { Button, Segmented, TextField } from "../ui/components";
import { updateProfile, verifyEmail } from "./actions";
import { useSession } from "./SessionProvider";

const LOCALE_BY_LANG: Record<string, string> = { he: "he-IL", en: "en-US" };
const LANG_BY_LOCALE = (locale: string) => (locale.startsWith("he") ? "he" : "en");

/**
 * Profile editor: name, email, language, OTP channel — everything the member owns
 * (UpdateUserAttributes; a changed email additionally collects the verification code).
 * The saved locale reaches i18n through the SessionProvider locale sync (profile.locale is
 * the signed-in source of truth), not an explicit changeLanguage here. The OTP channel
 * chooser mirrors the admin kill switches (same public config predicate as sign-up): a
 * disabled channel is never offered, and a single available channel needs no chooser at all.
 */
export function ProfileEditor() {
  const { t, i18n } = useTranslation();
  const { profile } = useSession();
  const [firstName, setFirstName] = useState(profile?.firstName ?? "");
  const [lastName, setLastName] = useState(profile?.lastName ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [lang, setLang] = useState(LANG_BY_LOCALE(profile?.locale ?? i18n.language));
  const [channel, setChannel] = useState<OtpChannel>(profile?.otpChannel ?? "whatsapp");
  const [channelOptions, setChannelOptions] = useState<OtpChannelOptions | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "saved" | "error">("idle");
  const [emailCode, setEmailCode] = useState<string | null>(null); // non-null = collecting
  const [code, setCode] = useState("");

  // Kill-switch-aware channel options (public config endpoint; SMS-only when unreachable) —
  // fetched once so an admin-disabled channel is never rendered as a choice.
  useEffect(() => {
    let cancelled = false;
    void fetchOtpChannelOptions().then((options) => {
      if (!cancelled) setChannelOptions(options);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!profile) return null;

  const onSave = async () => {
    setState("busy");
    try {
      const { emailCodeSent } = await updateProfile({
        ...(firstName !== profile.firstName ? { firstName } : {}),
        ...(lastName !== profile.lastName ? { lastName } : {}),
        ...(email && email !== (profile.email ?? "") ? { email } : {}),
        ...(LOCALE_BY_LANG[lang] !== profile.locale ? { locale: LOCALE_BY_LANG[lang] } : {}),
        ...(channel !== profile.otpChannel ? { otpChannel: channel } : {}),
      });
      if (emailCodeSent) setEmailCode("");
      setState("saved");
    } catch {
      setState("error");
    }
  };

  const onVerifyEmail = async () => {
    setState("busy");
    try {
      await verifyEmail(code);
      setEmailCode(null);
      setState("saved");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="flex flex-col gap-3">
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
      />
      {emailCode !== null && (
        <div className="flex flex-col gap-2 rounded-input border border-line bg-page p-2.5">
          <span className="text-[12.5px] text-muted">{t("user.emailCodeSent")}</span>
          <TextField
            name="emailCode"
            dir="ltr"
            label={t("user.emailCodeLabel")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button onClick={() => void onVerifyEmail()} disabled={!code || state === "busy"}>
            {t("user.verifyEmail")}
          </Button>
        </div>
      )}
      <div>
        <span className="mb-1.5 block text-sm font-medium text-muted">{t("auth.language")}</span>
        <Segmented
          value={lang}
          onChange={setLang}
          options={[
            { value: "en", label: "English" },
            { value: "he", label: "עברית" },
          ]}
        />
      </div>
      {channelOptions && channelOptions.channels.length > 1 && (
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">
            {t("auth.channelLabel")}
          </span>
          <Segmented
            value={channel}
            onChange={(v) => setChannel(v as OtpChannel)}
            options={channelOptions.channels.map((c) => ({
              value: c,
              label: t(`auth.channel.${c}`),
            }))}
          />
        </div>
      )}
      {state === "error" && <p className="text-sm text-rejected">{t("auth.errors.generic")}</p>}
      {state === "saved" && emailCode === null && (
        <p className="text-sm text-accent">{t("user.saved")}</p>
      )}
      <Button
        onClick={() => void onSave()}
        loading={state === "busy"}
        disabled={!firstName || !lastName}
      >
        {t("user.save")}
      </Button>
    </div>
  );
}
