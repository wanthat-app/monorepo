import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { type ActivityItemWire, activityApi, walletApi } from "../../lib/api";
import { formatMoneyMinor, splitMoneyMinor } from "../../lib/money";
import { Logo } from "../../ui/brand";
import { Button } from "../../ui/components";
import { ActivityRow, BalanceCard, PromptCard, TabBar, TopNav } from "../../ui/wallet";
import { enrollPasskey, listPasskeys, passkeysSupported, UserChip, useSession } from "../../user";

const ROW_STATUS = { confirmed: "confirmed", pending: "pending", clawback: "rejected" } as const;

const FACE_ICON = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M7 21H5a2 2 0 0 1-2-2v-2M17 21h2a2 2 0 0 0 2-2v-2" />
    <path d="M9 9h.01M15 9h.01M9.5 15a3.5 3.5 0 0 0 5 0" />
  </svg>
);

/**
 * Member home — the wallet dashboard (design handoff: Wallet flow, Home). Balance + activity come
 * from the wallet endpoints (Bearer access token via useSession — app-core is wallet-only after
 * ADR-0006). The profile is the module's ID-token claims; the avatar is the module's UserChip
 * (profile edit, passkeys and sign-out all live inside it). The Face ID prompt card is live —
 * shown only to members with no enrolled passkey (server truth via Cognito
 * ListWebAuthnCredentials; hidden while unknown so the enrolled majority never sees a flash).
 */
export function HomePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { profile, loading, accessToken } = useSession();
  const [passkeyState, setPasskeyState] = useState<"idle" | "enrolling" | "done" | "error">("idle");

  const token = accessToken();
  const wallet = useQuery({
    queryKey: ["wallet", profile?.sub],
    queryFn: () => walletApi.get(token as string),
    enabled: !!token && !!profile,
  });
  // No explicit limit: the server applies CONFIG home.recentActivityLimit (admin-tunable).
  const activity = useQuery({
    queryKey: ["activity", profile?.sub],
    queryFn: () => activityApi.list(token as string),
    enabled: !!token && !!profile,
  });
  const passkeys = useQuery({
    queryKey: ["passkeys", profile?.sub],
    queryFn: () => listPasskeys(),
    enabled: !!profile && passkeysSupported(),
  });

  // Wait out the session rehydrate before deciding — a hard reload of /home must not bounce a
  // signed-in member to /auth while the refresh-token exchange is in flight.
  if (loading) return null;
  if (!profile) {
    navigate("/auth", { replace: true });
    return null;
  }

  const onEnrollPasskey = async () => {
    setPasskeyState("enrolling");
    try {
      await enrollPasskey();
      setPasskeyState("done");
    } catch {
      setPasskeyState("error");
    }
  };

  const userChip = <UserChip onSignedOut={() => navigate("/auth", { replace: true })} />;

  const est = wallet.data?.estimated ?? null;
  const [amount, fraction] = est ? splitMoneyMinor(est.available.amountMinor, "ILS") : ["", ""];
  const holdings = (wallet.data?.balances ?? []).map((b) =>
    formatMoneyMinor(b.available.amountMinor, b.available.currency),
  );
  // Computed inline (not a boolean flag) so TS keeps the `est` narrowing at the usage site.
  const pendingNote =
    est && BigInt(est.pending.amountMinor) > 0n
      ? t("home.pendingNote", { amount: formatMoneyMinor(est.pending.amountMinor, "ILS") })
      : undefined;
  const dateLocale = i18n.language.startsWith("he") ? "he-IL" : "en-US";
  const itemMeta = (at: string) =>
    new Date(at).toLocaleDateString(dateLocale, { day: "numeric", month: "short" });

  return (
    <div className="relative flex min-h-screen flex-col bg-page">
      {/* Desktop chrome: top nav. */}
      <div className="hidden md:block">
        <TopNav
          links={[
            { key: "home", label: t("home.navHome"), active: true },
            { key: "activity", label: t("home.navActivity"), onClick: () => navigate("/activity") },
          ]}
          createLabel={t("home.createLink")}
          onCreate={() => navigate("/create")}
          profileSlot={userChip}
        />
      </div>
      {/* Mobile chrome: brand + avatar header. */}
      <header className="flex items-center justify-between px-6 pt-5 md:hidden">
        <Logo size="sm" />
        {userChip}
      </header>

      <main className="mx-auto flex w-full max-w-[430px] flex-1 flex-col gap-4 px-6 pb-32 pt-5 md:max-w-[640px] md:pb-12 md:pt-8">
        {wallet.isError ? (
          <div className="flex flex-col items-center gap-3 rounded-card bg-surface p-6">
            <p className="text-sm text-muted">{t("home.loadFailed")}</p>
            <Button variant="ghost" onClick={() => void wallet.refetch()}>
              {t("home.retry")}
            </Button>
          </div>
        ) : (
          <BalanceCard
            loading={wallet.isPending}
            label={t("home.availableCashback")}
            chip={
              est ? (
                <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold text-onink">
                  {t("home.estimated")}
                </span>
              ) : undefined
            }
            approx={est !== null}
            amount={est ? amount : undefined}
            fraction={est ? fraction : undefined}
            holdings={holdings.length ? holdings : undefined}
            holdingsNote={holdings.length ? t("home.heldNote") : undefined}
            pendingNote={pendingNote}
            cta={t("home.withdrawCash")}
          />
        )}

        {/* "Turn a link into cashback" promo (design: Home) — the whole card opens the create flow. */}
        <button
          type="button"
          onClick={() => navigate("/create")}
          className="rounded-card border border-line bg-surface p-5 text-start transition hover:border-accent-border"
        >
          <h2 className="text-[15px] font-bold text-ink">{t("home.turnLinkTitle")}</h2>
          <p className="mt-0.5 text-[13px] text-muted">{t("home.turnLinkSub")}</p>
          <span className="mt-3 flex items-center gap-2.5 rounded-field border border-edge bg-page px-4 py-2.5">
            <span className="min-w-0 flex-1 truncate text-start text-sm text-placeholder">
              {t("home.pastePlaceholder")}
            </span>
            <span className="shrink-0 rounded-full bg-accent px-3.5 py-1.5 text-xs font-bold text-white">
              + {t("home.createLink")}
            </span>
          </span>
        </button>

        {/* Only members who have NOT enrolled a passkey yet see the prompt. `length === 0` is the
            deliberate gate: while the list is loading (or failed) it is undefined, so enrolled
            members never see the card flash and an outage stays quiet rather than nagging. */}
        {passkeysSupported() && passkeyState !== "done" && passkeys.data?.length === 0 && (
          <PromptCard
            icon={FACE_ICON}
            title={t("home.setupFaceId")}
            subtitle={
              passkeyState === "error" ? t("auth.errors.generic") : t("home.setupFaceIdSub")
            }
            actionLabel={passkeyState === "enrolling" ? "…" : t("home.turnOn")}
            onAction={() => void onEnrollPasskey()}
          />
        )}
        {passkeyState === "done" && <p className="text-sm text-accent">{t("home.passkeyDone")}</p>}

        <section className="rounded-card bg-surface p-5">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-[15px] font-bold text-ink">{t("home.recentActivity")}</h2>
            <button
              type="button"
              onClick={() => navigate("/activity")}
              className="text-[13px] font-bold text-accent"
            >
              {t("home.seeAll")}
            </button>
          </div>
          {activity.isPending || activity.isError ? (
            [0, 1, 2].map((i) => <ActivityRow key={i} loading />)
          ) : activity.data.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">{t("home.noActivity")}</p>
          ) : (
            activity.data.items.map((item) => (
              <MemberActivityRow key={rowKey(item)} item={item} meta={itemMeta(item.at)} />
            ))
          )}
        </section>
      </main>

      {/* Mobile chrome: bottom tabs + create FAB. */}
      <nav className="fixed inset-x-0 bottom-0 md:hidden">
        <TabBar
          homeLabel={t("home.navHome")}
          activityLabel={t("home.navActivity")}
          active="home"
          createLabel={t("home.createLink")}
          onActivity={() => navigate("/activity")}
          onCreate={() => navigate("/create")}
        />
      </nav>
    </div>
  );
}

/** Stable list key: wallet rows have a ledger id; a recommendation is created once. */
export function rowKey(item: ActivityItemWire): string {
  return item.type === "wallet_entry" ? item.id : `rec-${item.recommendationId}`;
}

const SHARE_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.6 13.5l6.9 4M15.5 6.5l-7 4" />
  </svg>
);

const CHECK_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

/** Re-share a recommendation from its activity row: system share sheet, clipboard fallback. */
function ShareRecommendationButton({
  recommendationId,
  title,
}: {
  recommendationId: string;
  title: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const shareUrl = `${globalThis.location.origin}/p/${encodeURIComponent(recommendationId)}`;

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title, url: shareUrl });
        return;
      } catch {
        return; // share sheet dismissed - nothing to do
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions) - the landing page remains reachable via the row.
    }
  };

  return (
    <button
      type="button"
      aria-label={t("memberActivity.share")}
      onClick={() => void share()}
      className="ms-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-edge bg-page text-ink transition hover:border-accent-border"
    >
      {copied ? CHECK_ICON : SHARE_ICON}
    </button>
  );
}

/** One merged-feed row — wallet movements as before, creations as re-shareable "Recommended" rows. */
export function MemberActivityRow({ item, meta }: { item: ActivityItemWire; meta: string }) {
  const { t } = useTranslation();
  if (item.type === "wallet_entry") {
    return (
      <ActivityRow
        title={t(`home.kind.${item.kind}`)}
        status={ROW_STATUS[item.status]}
        statusLabel={t(`home.status.${item.status}`)}
        meta={meta}
        amount={formatMoneyMinor(item.amount.amountMinor, item.amount.currency)}
      />
    );
  }
  return (
    <ActivityRow
      thumb={
        item.imageUrl ? (
          // ActivityRow renders the thumb slot raw - the wrapper must own its size (44px, the
          // row's design thumb), or the image renders at natural size and floods the row.
          <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-thumb border border-line bg-page">
            <img
              src={item.imageUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="max-h-full max-w-full object-contain"
            />
          </span>
        ) : undefined
      }
      title={t("home.kind.recommendation_created")}
      meta={`${item.title.length > 40 ? `${item.title.slice(0, 40)}…` : item.title} · ${meta}`}
      action={
        <ShareRecommendationButton recommendationId={item.recommendationId} title={item.title} />
      }
    />
  );
}
