import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { BackButton, Card, Screen } from "../../ui";
import { ProfileEditor, useSession } from "../../user";

/**
 * The member's profile page (/profile) — a full page rather than a dropdown panel, reached
 * from the UserChip menu. Pure chrome around the user module's ProfileEditor; the same
 * session guard as the other member pages.
 */
export function ProfilePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { profile, loading } = useSession();

  // Wait out the session rehydrate before deciding — a hard reload of /profile must not bounce
  // a signed-in member to /auth while the refresh-token exchange is in flight.
  if (loading) return null;
  if (!profile) {
    navigate("/auth", { replace: true });
    return null;
  }

  return (
    <Screen>
      <Card className="flex flex-col gap-4">
        <div>
          <BackButton onClick={() => navigate("/home")} label={t("auth.back")} />
        </div>
        <h1 className="text-[27px] tracking-[-0.03em]">{t("user.profileTitle")}</h1>
        <ProfileEditor />
      </Card>
    </Screen>
  );
}
