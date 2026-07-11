import type { AdminUserItem, AdminUserRecommendationItem } from "@wanthat/contracts";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { type AdminUserWalletWire, adminApi } from "../../lib/admin-api";
import { formatMoneyMinor } from "../../lib/money";
import { Skeleton, StatusBadge } from "../../ui/components";

const ROW_STATUS = { confirmed: "confirmed", pending: "pending", clawback: "rejected" } as const;

/**
 * Admin user detail: one member's identity (Cognito via admin-credentials), wallet (balances
 * derived from their ledger slice + newest history, via admin-api as app_ro) and every
 * recommendation they created (byOwner, newest first, cursor-paged). Read-only — moderation
 * stays on the users list.
 */
export function UserDetailView({ token, sub }: { token: string | null; sub: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [user, setUser] = useState<AdminUserItem | null>(null);
  const [userStatus, setUserStatus] = useState<"loading" | "ready" | "missing" | "failed">(
    "loading",
  );
  const [wallet, setWallet] = useState<AdminUserWalletWire | null>(null);
  const [walletFailed, setWalletFailed] = useState(false);
  const [recs, setRecs] = useState<AdminUserRecommendationItem[] | null>(null);
  const [recsCursor, setRecsCursor] = useState<string | null>(null);
  const [recsFailed, setRecsFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Each section renders AS ITS OWN call lands — Promise.allSettled here once serialized the
  // whole page on the slowest call (the wallet's Aurora read can ride a scale-to-zero resume),
  // hiding already-loaded identity and recommendations for seconds.
  const load = useCallback(() => {
    if (!token) return;
    setUserStatus("loading");
    setUser(null);
    setWallet(null);
    setWalletFailed(false);
    setRecs(null);
    setRecsCursor(null);
    setRecsFailed(false);
    adminApi.getUser(token, sub).then(
      (res) => {
        setUser(res.user);
        setUserStatus("ready");
      },
      (err) => setUserStatus((err as { status?: number }).status === 404 ? "missing" : "failed"),
    );
    adminApi.getUserWallet(token, sub).then(
      (res) => setWallet(res),
      () => setWalletFailed(true),
    );
    adminApi.listUserRecommendations(token, sub).then(
      (res) => {
        setRecs(res.items);
        setRecsCursor(res.nextCursor);
      },
      () => setRecsFailed(true),
    );
  }, [token, sub]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMoreRecs = async () => {
    if (!token || !recsCursor) return;
    setLoadingMore(true);
    try {
      const res = await adminApi.listUserRecommendations(token, sub, recsCursor);
      setRecs((prev) => [...(prev ?? []), ...res.items]);
      setRecsCursor(res.nextCursor);
    } catch {
      setRecsFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const dateLocale = i18n.language.startsWith("he") ? "he-IL" : "en-US";
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(dateLocale, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

  if (userStatus === "missing") {
    return <p className="text-sm text-muted">{t("admin.userPage.notFound")}</p>;
  }

  return (
    <div className="max-w-[1080px]">
      <button
        type="button"
        onClick={() => navigate("/admin/users")}
        className="mb-4 text-[13px] font-bold text-accent"
      >
        ‹ {t("admin.userPage.backToList")}
      </button>

      {/* Identity */}
      <div className="mb-4 rounded-card border border-line bg-surface p-5">
        {userStatus === "loading" ? (
          <>
            <Skeleton className="mb-2 h-6 w-56" />
            <Skeleton className="h-4 w-80" />
          </>
        ) : userStatus === "failed" ? (
          <p className="text-sm text-muted">{t("admin.userPage.loadFailed")}</p>
        ) : user ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <h2 className="text-[17px] font-bold text-ink">
              {`${user.firstName} ${user.lastName}`.trim() || t("admin.userPage.noName")}
            </h2>
            <StatusBadge status={user.status === "active" ? "confirmed" : "pending"}>
              {user.status === "active"
                ? t("admin.usersPage.active")
                : t("admin.usersPage.suspended")}
            </StatusBadge>
            <span className="tabular text-[13px] text-muted" dir="ltr">
              {user.phone}
            </span>
            <span className="text-[13px] text-muted" dir="ltr">
              {user.email ?? "—"}
            </span>
            <span className="text-[13px] text-muted">
              {t("admin.userPage.memberSince")} {fmtDate(user.createdAt)}
            </span>
            <span className="tabular font-mono text-[11.5px] text-muted" dir="ltr">
              {sub}
            </span>
          </div>
        ) : null}
      </div>

      {/* Wallet */}
      <div className="mb-4 rounded-card border border-line bg-surface p-5">
        <h3 className="mb-3 text-[14px] font-bold text-ink">{t("admin.userPage.wallet")}</h3>
        {walletFailed ? (
          <p className="text-sm text-muted">{t("admin.userPage.loadFailed")}</p>
        ) : !wallet ? (
          <Skeleton className="h-16 w-full" />
        ) : wallet.balances.length === 0 ? (
          <p className="text-sm text-muted">{t("admin.userPage.emptyWallet")}</p>
        ) : (
          <div className="mb-4 flex flex-wrap gap-3">
            {wallet.balances.map((b) => (
              <div
                key={b.available.currency}
                className="rounded-tile border border-edge bg-page px-4 py-3"
                dir="ltr"
              >
                <div className="tabular text-[19px] font-bold text-ink">
                  {formatMoneyMinor(b.available.amountMinor, b.available.currency)}
                </div>
                <div className="mt-1 text-[11.5px] text-muted">
                  {t("admin.userPage.asRecommender")}:{" "}
                  {formatMoneyMinor(b.asRecommender.confirmed.amountMinor, b.available.currency)} +{" "}
                  {formatMoneyMinor(b.asRecommender.pending.amountMinor, b.available.currency)}{" "}
                  {t("admin.userPage.pendingShort")} · {t("admin.userPage.asBuyer")}:{" "}
                  {formatMoneyMinor(b.asBuyer.confirmed.amountMinor, b.available.currency)} +{" "}
                  {formatMoneyMinor(b.asBuyer.pending.amountMinor, b.available.currency)}{" "}
                  {t("admin.userPage.pendingShort")}
                </div>
              </div>
            ))}
          </div>
        )}
        {wallet && wallet.entries.items.length > 0 ? (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted">
                <Th>{t("admin.userPage.entryKind")}</Th>
                <Th>{t("admin.userPage.amount")}</Th>
                <Th>{t("admin.userPage.status")}</Th>
                <Th>{t("admin.userPage.recommendation")}</Th>
                <Th>{t("admin.userPage.date")}</Th>
              </tr>
            </thead>
            <tbody>
              {wallet.entries.items.map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2">{t(`home.kind.${e.kind}`)}</td>
                  <td className="tabular px-3 py-2 font-semibold" dir="ltr">
                    {formatMoneyMinor(e.amount.amountMinor, e.amount.currency)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={ROW_STATUS[e.status]}>
                      {t(`home.status.${e.status}`)}
                    </StatusBadge>
                  </td>
                  <td className="px-3 py-2 font-mono text-[12px] text-muted" dir="ltr">
                    {e.recommendationId ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-muted">{fmtDate(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      {/* Recommendations */}
      <div className="rounded-card border border-line bg-surface p-5">
        <h3 className="mb-3 text-[14px] font-bold text-ink">
          {t("admin.userPage.recommendations")}
        </h3>
        {recsFailed ? (
          <p className="text-sm text-muted">{t("admin.userPage.loadFailed")}</p>
        ) : !recs ? (
          <Skeleton className="h-16 w-full" />
        ) : recs.length === 0 ? (
          <p className="text-sm text-muted">{t("admin.userPage.noRecommendations")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {recs.map((r) => (
              <div
                key={r.recommendationId}
                className="flex items-center gap-4 rounded-tile border border-edge bg-page p-3"
              >
                {r.imageUrl ? (
                  <img
                    src={r.imageUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-14 w-14 shrink-0 rounded-thumb border border-line object-contain"
                  />
                ) : (
                  <div className="h-14 w-14 shrink-0 rounded-thumb border border-line" />
                )}
                <div className="min-w-0 flex-1">
                  <a
                    href={`/p/${encodeURIComponent(r.recommendationId)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-[13.5px] font-semibold text-accent underline-offset-2 hover:underline"
                  >
                    {r.title}
                  </a>
                  <div className="mt-0.5 text-[12px] text-muted" dir="ltr">
                    {r.price ? formatMoneyMinor(r.price.amountMinor, r.price.currency) : "—"} ·{" "}
                    {t("admin.userPage.commission")} {pct(r.commissionBps)} ·{" "}
                    {t("admin.userPage.split")} {pct(r.cashback.referrerBps)}/
                    {pct(r.cashback.consumerBps)}
                  </div>
                </div>
                <div className="shrink-0 text-end text-[12px] text-muted">
                  <div>
                    {r.conversions} {t("admin.userPage.conversions")}
                  </div>
                  <div className="mt-0.5">{fmtDate(r.createdAt)}</div>
                </div>
              </div>
            ))}
            {recsCursor ? (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMoreRecs()}
                className="self-center rounded-tile border border-edge bg-surface px-4 py-2 text-[12.5px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("admin.orders.loadMore")}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-start font-semibold">{children}</th>;
}
