import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { completeAdminLogin, verifyAdminOauthState } from "../../lib/admin-login";
import { Spinner } from "../../ui/components";

/**
 * OAuth callback for the employee Managed Login flow (ADR-0020 §two-pool): verify CSRF `state`,
 * exchange the code for admin tokens, then route into the console. Follows the document direction
 * (RTL for Hebrew, the default) like the rest of the admin surface.
 */
export function AdminCallbackPage() {
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
      .then(() => navigate("/admin", { replace: true }))
      .catch(() => setError(true));
  }, [navigate]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-muted">
      {error ? <p>{t("auth.errors.generic")}</p> : <Spinner />}
    </div>
  );
}
