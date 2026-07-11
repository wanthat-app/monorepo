import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  completeAdminLogin,
  consumeAdminReturnPath,
  verifyAdminOauthState,
} from "../../lib/admin-login";
import { Spinner } from "../../ui/components";
import { AdminI18nProvider } from "./AdminI18nProvider";

/**
 * OAuth callback for the employee Managed Login flow (ADR-0006 §two-pool): verify CSRF `state`,
 * exchange the code for admin tokens, then route into the console. Renders inside the admin
 * i18n boundary — the console's own language + direction, independent of the member app.
 */
export function AdminCallbackPage() {
  return (
    <AdminI18nProvider>
      <AdminCallback />
    </AdminI18nProvider>
  );
}

function AdminCallback() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) {
      navigate("/admin", { replace: true });
      return;
    }
    // CSRF: the returned `state` must match the value stashed before the redirect. Verify (and clear)
    // it before touching the code — a mismatch means the callback wasn't initiated by us.
    if (!verifyAdminOauthState(params.get("state"))) {
      setError(true);
      return;
    }
    completeAdminLogin(code)
      .then(() => navigate(consumeAdminReturnPath(), { replace: true }))
      .catch(() => setError(true));
  }, [navigate]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-muted">
      {error ? <p>{t("auth.errors.generic")}</p> : <Spinner />}
    </div>
  );
}
