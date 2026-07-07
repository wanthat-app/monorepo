import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { type WalletEntryWire, walletApi } from "../../lib/api";
import { formatMoneyMinor, splitMoneyMinor } from "../../lib/money";
import { enrollPasskey, passkeysSupported } from "../../lib/passkey";
import { useSession } from "../../lib/session";
import { Logo } from "../../ui/brand";
import { Button } from "../../ui/components";
import { ActivityRow, BalanceCard, ProfileChip, PromptCard, TabBar, TopNav } from "../../ui/wallet";

const RECENT_LIMIT = 4;
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
 * from the wallet endpoints (stubbed empty until the poller slice writes the ledger). Create link,
 * Activity, Profile, See all and Withdraw are visible per the design but inert this slice; the
 * Face ID prompt card is live. Sign-out stays reachable via the avatar menu meanwhile.
 */
export function HomePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { customer, accessToken, signOut } = useSession();
  const [passkeyState, setPasskeyState] = useState<"idle" | "enrolling" | "done" | "error">("idle");
  const [menuOpen, setMenuOpen] = useState(false);

  const token = accessToken();
  const wallet = useQuery({
    queryKey: ["wallet"],
    queryFn: () => walletApi.get(token as string),
    enabled: !!token,
  });
  const entries = useQuery({
    queryKey: ["wallet-entries", RECENT_LIMIT],
    queryFn: () => walletApi.entries(token as string, RECENT_LIMIT),
    enabled: !!token,
  });

  if (!customer) {
    navigate("/auth", { replace: true });
    return null;
  }

  const onEnrollPasskey = async () => {
    if (!token) return;
    setPasskeyState("enrolling");
    try {
      await enrollPasskey(token);
      setPasskeyState("done");
    } catch {
      setPasskeyState("error");
    }
  };

  const onSignOut = async () => {
    await signOut();
    navigate("/auth", { replace: true });
  };

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
  const entryMeta = (e: WalletEntryWire) =>
    new Date(e.createdAt).toLocaleDateString(dateLocale, { day: "numeric", month: "short" });

  const profileMenu = menuOpen ? (
    <div className="absolute end-6 top-16 z-20 min-w-36 rounded-input border border-line bg-surface p-1.5 shadow-[0_1px_2px_rgba(0,0,0,.08)]">
      <button
        type="button"
        onClick={() => void onSignOut()}
        className="w-full rounded-[9px] px-3 py-2 text-start text-sm font-semibold text-ink transition hover:bg-page"
      >
        {t("home.signOut")}
      </button>
    </div>
  ) : null;

  return (
    <div className="relative flex min-h-screen flex-col bg-page">
      {/* Desktop chrome: top nav. Activity / Create link / avatar-menu-open are the slice's inert edges. */}
      <div className="hidden md:block">
        <TopNav
          links={[
            { key: "home", label: t("home.navHome"), active: true },
            { key: "activity", label: t("home.navActivity") },
          ]}
          createLabel={t("home.createLink")}
          profileInitial={customer.firstName.charAt(0).toUpperCase()}
          onProfile={() => setMenuOpen((v) => !v)}
        />
      </div>
      {/* Mobile chrome: brand + avatar header. */}
      <header className="flex items-center justify-between px-6 pt-5 md:hidden">
        <Logo size="sm" />
        <ProfileChip
          initial={customer.firstName.charAt(0).toUpperCase()}
          onClick={() => setMenuOpen((v) => !v)}
          size={36}
        />
      </header>
      {profileMenu}

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

        {passkeysSupported() && passkeyState !== "done" && (
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
            <button type="button" className="text-[13px] font-bold text-accent">
              {t("home.seeAll")}
            </button>
          </div>
          {entries.isPending || entries.isError ? (
            [0, 1, 2].map((i) => <ActivityRow key={i} loading />)
          ) : entries.data.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">{t("home.noActivity")}</p>
          ) : (
            entries.data.items.map((e) => (
              <ActivityRow
                key={e.id}
                title={t(`home.kind.${e.kind}`)}
                status={ROW_STATUS[e.status]}
                statusLabel={t(`home.status.${e.status}`)}
                meta={entryMeta(e)}
                amount={formatMoneyMinor(e.amount.amountMinor, e.amount.currency)}
              />
            ))
          )}
        </section>
      </main>

      {/* Mobile chrome: bottom tabs + create FAB (inert this slice). */}
      <nav className="fixed inset-x-0 bottom-0 md:hidden">
        <TabBar
          homeLabel={t("home.navHome")}
          activityLabel={t("home.navActivity")}
          active="home"
          createLabel={t("home.createLink")}
        />
      </nav>
    </div>
  );
}
