import { Button, ProfileChip, Spinner } from "@wanthat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { enrollPasskey, listPasskeys, type PasskeySummary, signOut } from "./actions";
import { CognitoError } from "./cognito";
import { useSession } from "./SessionProvider";
import { biometricLabelKey, passkeysSupported } from "./webauthn";

type View = "menu" | "passkeys";

/**
 * The module's exported UI face (ADR-0006 T4): avatar chip + menu (profile, passkeys, sign
 * out). Pure consumer of `useSession()` + the module actions — no auth logic lives here.
 * Renders nothing while signed out, so pages can mount it unconditionally. The profile
 * editor is a full page of its own (/profile) — the host passes `onProfile` to navigate
 * there (the module stays router-free); passkeys remain an inline panel.
 */
export function UserChip({
  size = 36,
  onProfile,
  onSignedOut,
}: {
  size?: number;
  /** Opens the member's profile page — the menu item is hidden when absent. */
  onProfile?: () => void;
  onSignedOut?: () => void;
}) {
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
              onProfile={
                onProfile
                  ? () => {
                      setOpen(false);
                      onProfile();
                    }
                  : undefined
              }
              onPasskeys={passkeysSupported() ? () => setView("passkeys") : undefined}
              onSignOut={() => void onSignOut()}
            />
          )}
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
  onProfile?: () => void;
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
        {onProfile && <MenuItem label={t("user.profile")} onClick={onProfile} />}
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
