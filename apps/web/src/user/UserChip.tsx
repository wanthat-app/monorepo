import type { OtpChannel } from "@wanthat/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Segmented, Spinner, TextField } from "../ui/components";
import { ProfileChip } from "../ui/wallet";
import {
  enrollPasskey,
  listPasskeys,
  type PasskeySummary,
  signOut,
  updateProfile,
  verifyEmail,
} from "./actions";
import { CognitoError } from "./cognito";
import { useSession } from "./SessionProvider";
import { biometricLabelKey, passkeysSupported } from "./webauthn";

const LOCALE_BY_LANG: Record<string, string> = { he: "he-IL", en: "en-US" };
const LANG_BY_LOCALE = (locale: string) => (locale.startsWith("he") ? "he" : "en");

type View = "menu" | "profile" | "passkeys";

/**
 * The module's exported UI face (ADR-0006 T4): avatar chip + menu (profile, passkeys, sign
 * out). Pure consumer of `useSession()` + the module actions — no auth logic lives here.
 * Renders nothing while signed out, so pages can mount it unconditionally.
 */
export function UserChip({ size = 36, onSignedOut }: { size?: number; onSignedOut?: () => void }) {
  const { t } = useTranslation();
  const { profile } = useSession();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");

  if (!profile) return null;
  const initial = (profile.firstName || profile.phone.replace("+", "")).charAt(0).toUpperCase();

  const toggle = () => {
    setOpen((v) => !v);
    setView("menu");
  };

  const onSignOut = async () => {
    await signOut();
    setOpen(false);
    onSignedOut?.();
  };

  return (
    <div className="relative">
      <ProfileChip initial={initial} onClick={toggle} size={size} label={t("user.menuLabel")} />
      {open && (
        <div className="absolute end-0 top-full z-20 mt-2 w-72 rounded-input border border-line bg-surface p-1.5 text-start shadow-[0_4px_16px_rgba(0,0,0,.1)]">
          {view === "menu" && (
            <Menu
              name={`${profile.firstName} ${profile.lastName}`.trim() || profile.phone}
              phone={profile.phone}
              onProfile={() => setView("profile")}
              onPasskeys={passkeysSupported() ? () => setView("passkeys") : undefined}
              onSignOut={() => void onSignOut()}
            />
          )}
          {view === "profile" && <ProfilePanel onBack={() => setView("menu")} />}
          {view === "passkeys" && <PasskeysPanel onBack={() => setView("menu")} />}
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-[9px] px-3 py-2 text-start text-sm font-semibold text-ink transition hover:bg-page"
    >
      {label}
    </button>
  );
}

function Menu({
  name,
  phone,
  onProfile,
  onPasskeys,
  onSignOut,
}: {
  name: string;
  phone: string;
  onProfile: () => void;
  onPasskeys?: () => void;
  onSignOut: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="border-b border-line px-3 pb-2 pt-1.5">
        <div className="truncate text-sm font-bold text-ink">{name}</div>
        <div className="text-[12.5px] text-muted" dir="ltr">
          {phone}
        </div>
      </div>
      <div className="pt-1">
        <MenuItem label={t("user.profile")} onClick={onProfile} />
        {onPasskeys && <MenuItem label={t("user.passkeys")} onClick={onPasskeys} />}
        <MenuItem label={t("user.signOut")} onClick={onSignOut} />
      </div>
    </>
  );
}

function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between border-b border-line px-3 pb-2 pt-1.5">
      <span className="text-sm font-bold text-ink">{title}</span>
      <button
        type="button"
        onClick={onBack}
        className="text-[12.5px] font-semibold text-accent hover:opacity-80"
      >
        {t("auth.back")}
      </button>
    </div>
  );
}

/**
 * Profile editor: name, email, language, OTP channel — everything the member owns
 * (UpdateUserAttributes; a changed email additionally collects the verification code).
 */
function ProfilePanel({ onBack }: { onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const { profile } = useSession();
  const [firstName, setFirstName] = useState(profile?.firstName ?? "");
  const [lastName, setLastName] = useState(profile?.lastName ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [lang, setLang] = useState(LANG_BY_LOCALE(profile?.locale ?? i18n.language));
  const [channel, setChannel] = useState<OtpChannel>(profile?.otpChannel ?? "whatsapp");
  const [state, setState] = useState<"idle" | "busy" | "saved" | "error">("idle");
  const [emailCode, setEmailCode] = useState<string | null>(null); // non-null = collecting
  const [code, setCode] = useState("");

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
      if (lang !== LANG_BY_LOCALE(profile.locale)) void i18n.changeLanguage(lang);
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
    <>
      <PanelHeader title={t("user.profileTitle")} onBack={onBack} />
      <div className="flex flex-col gap-3 p-3">
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
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">
            {t("auth.channelLabel")}
          </span>
          <Segmented
            value={channel}
            onChange={(v) => setChannel(v as OtpChannel)}
            options={[
              { value: "whatsapp", label: t("auth.channel.whatsapp") },
              { value: "sms", label: t("auth.channel.sms") },
            ]}
          />
        </div>
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
    </>
  );
}

/** Enrolled-passkey inventory + one-tap enrolment with the device-matched biometric label. */
function PasskeysPanel({ onBack }: { onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "added" | "error">("idle");
  const bioLabel = t(`auth.biometric.${biometricLabelKey()}`);

  useEffect(() => {
    listPasskeys()
      .then(setPasskeys)
      .catch(() => setPasskeys([]));
  }, []);

  const onAdd = async () => {
    setState("busy");
    try {
      await enrollPasskey();
      setState("added");
      setPasskeys(await listPasskeys().catch(() => passkeys ?? []));
    } catch (err) {
      // A cancelled OS sheet is not an error worth shouting about.
      setState(err instanceof CognitoError ? "error" : "idle");
    }
  };

  const dateLocale = i18n.language.startsWith("he") ? "he-IL" : "en-US";

  return (
    <>
      <PanelHeader title={t("user.passkeys")} onBack={onBack} />
      <div className="flex flex-col gap-3 p-3">
        {passkeys === null ? (
          <div className="flex justify-center py-2">
            <Spinner />
          </div>
        ) : passkeys.length === 0 ? (
          <p className="text-[13px] text-muted">{t("user.passkeysEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {passkeys.map((p) => (
              <li key={p.credentialId} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-semibold text-ink">
                  {p.name ?? t("user.passkeyGeneric")}
                </span>
                {p.createdAt && (
                  <span className="shrink-0 text-[12px] text-muted">
                    {new Date(p.createdAt).toLocaleDateString(dateLocale, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {state === "error" && (
          <p className="text-sm text-rejected">{t("auth.errors.invalid_passkey")}</p>
        )}
        {state === "added" && <p className="text-sm text-accent">{t("home.passkeyDone")}</p>}
        <Button onClick={() => void onAdd()} loading={state === "busy"}>
          {t("user.addPasskey", { label: bioLabel })}
        </Button>
      </div>
    </>
  );
}
