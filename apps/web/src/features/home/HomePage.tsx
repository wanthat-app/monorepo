import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { enrollPasskey, passkeysSupported } from "../../lib/passkey";
import { useSession } from "../../lib/session";
import { Button, Card, Screen } from "../../ui/components";

/**
 * Authenticated landing — a placeholder home for the auth slice (the wallet dashboard lands with its
 * own slice). It confirms the signed-in profile and offers passkey enrolment + sign-out.
 */
export function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { customer, accessToken, signOut } = useSession();
  const [passkeyState, setPasskeyState] = useState<"idle" | "enrolling" | "done" | "error">("idle");

  if (!customer) {
    navigate("/auth", { replace: true });
    return null;
  }

  const onEnrollPasskey = async () => {
    const token = accessToken();
    if (!token) return;
    setPasskeyState("enrolling");
    try {
      await enrollPasskey(token);
      setPasskeyState("done");
    } catch {
      setPasskeyState("error");
    }
  };

  return (
    <Screen>
      <Card className="flex flex-col gap-4">
        <h1 className="text-2xl">{t("home.greeting", { name: customer.firstName })}</h1>
        <p className="text-muted">{t("home.placeholder")}</p>

        {passkeysSupported() && passkeyState !== "done" && (
          <Button variant="ghost" onClick={onEnrollPasskey} loading={passkeyState === "enrolling"}>
            {t("home.enrollPasskey")}
          </Button>
        )}
        {passkeyState === "done" && <p className="text-accent">{t("home.passkeyDone")}</p>}
        {passkeyState === "error" && <p className="text-rejected">{t("auth.errors.generic")}</p>}

        <Button
          variant="ghost"
          onClick={async () => {
            await signOut();
            navigate("/auth", { replace: true });
          }}
        >
          {t("home.signOut")}
        </Button>
      </Card>
    </Screen>
  );
}
