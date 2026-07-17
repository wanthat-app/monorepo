import { Logo } from "@wanthat/ui";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { UserChip, useSession } from "../../user";

/**
 * Standard page header: the wanthat logo (→ home for members, the landing for guests) with
 * the account affordance on the end — the member's profile chip when signed in, a Log in
 * link when signed out. On /auth the link is suppressed (it would point at itself); the
 * UserChip renders nothing until the session resolves, so the header never flashes a wrong
 * state.
 */
export function AppHeader() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { status } = useSession();
  const onAuth = pathname.startsWith("/auth");

  return (
    <header className="flex items-center justify-between">
      <button
        type="button"
        onClick={() => navigate(status === "signedIn" ? "/home" : "/")}
        aria-label={t("app.title")}
      >
        <Logo size="md" />
      </button>
      {status === "signedIn" ? (
        <UserChip
          onProfile={() => navigate("/profile")}
          onSignedOut={() => navigate("/", { replace: true })}
        />
      ) : onAuth ? null : (
        <button
          type="button"
          onClick={() => navigate("/auth")}
          className="text-sm font-bold text-accent"
        >
          {t("app.login")}
        </button>
      )}
    </header>
  );
}
