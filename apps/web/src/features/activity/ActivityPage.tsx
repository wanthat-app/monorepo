import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { type ActivityItemWire, activityApi } from "../../lib/api";
import { Logo } from "../../ui/brand";
import { Button } from "../../ui/components";
import { ActivityRow, TabBar, TopNav } from "../../ui/wallet";
import { UserChip, useSession } from "../../user";
import { MemberActivityRow, rowKey } from "../home/HomePage";

const PAGE_SIZE = 20;

/**
 * The full activity page ("see all" from the home strip): the same merged feed — recommendation
 * creations + wallet movements, newest first — cursor-paged with an explicit page size.
 */
export function ActivityPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { profile, loading, accessToken } = useSession();
  const token = accessToken();

  const [items, setItems] = useState<ActivityItemWire[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      if (!token) return;
      setBusy(true);
      setFailed(false);
      try {
        const res = await activityApi.list(token, { limit: PAGE_SIZE, cursor });
        setItems((prev) => (cursor ? [...(prev ?? []), ...res.items] : res.items));
        setNextCursor(res.nextCursor);
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [token],
  );

  useEffect(() => {
    if (profile) void load();
  }, [load, profile]);

  // Wait out the session rehydrate before deciding — a hard reload of /activity must not bounce
  // a signed-in member to /auth while the refresh-token exchange is in flight.
  if (loading) return null;
  if (!profile) {
    navigate("/auth", { replace: true });
    return null;
  }

  const userChip = (
    <UserChip
      onProfile={() => navigate("/profile")}
      onSignedOut={() => navigate("/auth", { replace: true })}
    />
  );
  const dateLocale = i18n.language.startsWith("he") ? "he-IL" : "en-US";
  const itemMeta = (at: string) =>
    new Date(at).toLocaleDateString(dateLocale, { day: "numeric", month: "short" });

  return (
    <div className="relative flex min-h-screen flex-col bg-page">
      <div className="hidden md:block">
        <TopNav
          links={[
            { key: "home", label: t("home.navHome"), onClick: () => navigate("/home") },
            { key: "activity", label: t("home.navActivity"), active: true },
          ]}
          createLabel={t("home.createLink")}
          onCreate={() => navigate("/create")}
          profileSlot={userChip}
        />
      </div>
      <header className="flex items-center justify-between px-6 pt-5 md:hidden">
        <Logo size="sm" />
        {userChip}
      </header>

      <main className="mx-auto flex w-full max-w-[430px] flex-1 flex-col gap-4 px-6 pb-32 pt-5 md:max-w-[640px] md:pb-12 md:pt-8">
        <section className="rounded-card bg-surface p-5">
          <h1 className="mb-1 text-[15px] font-bold text-ink">{t("memberActivity.title")}</h1>
          {failed ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <p className="text-sm text-muted">{t("home.loadFailed")}</p>
              <Button variant="ghost" onClick={() => void load()}>
                {t("home.retry")}
              </Button>
            </div>
          ) : items === null ? (
            [0, 1, 2, 3].map((i) => <ActivityRow key={i} loading />)
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">{t("home.noActivity")}</p>
          ) : (
            <>
              {items.map((item) => (
                <MemberActivityRow key={rowKey(item)} item={item} meta={itemMeta(item.at)} />
              ))}
              {nextCursor ? (
                <div className="mt-3 flex justify-center">
                  <Button variant="ghost" disabled={busy} onClick={() => void load(nextCursor)}>
                    {t("memberActivity.loadMore")}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </section>
      </main>

      <nav className="fixed inset-x-0 bottom-0 md:hidden">
        <TabBar
          homeLabel={t("home.navHome")}
          activityLabel={t("home.navActivity")}
          active="activity"
          createLabel={t("home.createLink")}
          onHome={() => navigate("/home")}
          onCreate={() => navigate("/create")}
        />
      </nav>
    </div>
  );
}
