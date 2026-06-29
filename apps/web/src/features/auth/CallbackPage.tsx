import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { completePasskeyLogin } from "../../lib/managed-login";
import { useSession } from "../../lib/session";
import { Screen, Spinner } from "../../ui/components";

/** OAuth callback for the Managed Login passkey flow: exchange the code, then route by result. */
export function CallbackPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { signIn } = useSession();
  const [error, setError] = useState(false);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("code");
    if (!code) {
      navigate("/auth", { replace: true });
      return;
    }
    completePasskeyLogin(code)
      .then((session) => {
        if (session) {
          signIn(session);
          navigate("/home", { replace: true });
        } else {
          navigate("/auth", { replace: true }); // authenticated but unregistered
        }
      })
      .catch(() => setError(true));
  }, [navigate, signIn]);

  return (
    <Screen>
      <div className="flex flex-col items-center gap-3 text-muted">
        {error ? <p>{t("auth.errors.generic")}</p> : <Spinner />}
      </div>
    </Screen>
  );
}
