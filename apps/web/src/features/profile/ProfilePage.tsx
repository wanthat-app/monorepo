import { BackButton, Card, Screen } from "@wanthat/ui";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
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

  // Back to wherever the member came from (home, activity, …); /home when the profile was
  // opened directly and there is no in-app history entry to return to (react-router's data
  // router stamps its history index on window.history.state).
  const goBack = () => {
    if (window.history.state?.idx > 0) navigate(-1);
    else navigate("/home", { replace: true });
  };

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
          <BackButton onClick={goBack} label={t("auth.back")} />
        </div>
        <h1 className="text-[27px] tracking-[-0.03em]">{t("user.profileTitle")}</h1>
        {/* A landed save returns the member to where they came from. */}
        <ProfileEditor onSaved={goBack} />
      </Card>
    </Screen>
  );
}
