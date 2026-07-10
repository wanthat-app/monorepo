import type { UnattributedOrderState, UnattributedOrderView } from "@wanthat/contracts";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { adminApi } from "../../lib/admin-api";
import { formatMoneyMinor } from "../../lib/money";
import { Segmented, Skeleton } from "../../ui/components";

const STATES: UnattributedOrderState[] = ["open", "claimed", "settled", "dismissed"];

/**
 * Admin unattributed-orders page (Phase 2, 2026-07-10): the claim queue over commission-earning
 * orders that arrived without attribution. One state at a time (open by default). Claiming asks
 * for a recommendation id and only writes INTENT — the retailer-proxy heartbeat settles it
 * through the conversion writer within ~15 minutes, so a fresh claim shows as "claimed" here
 * and flips to "settled" on a later refresh.
 */
export function OrdersView({ token }: { token: string | null }) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<UnattributedOrderState>("open");
  const [items, setItems] = useState<UnattributedOrderView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(
    async (forState: UnattributedOrderState, cursor?: string) => {
      if (!token) return;
      setLoading(true);
      setLoadFailed(false);
      try {
        const res = await adminApi.listUnattributedOrders(token, forState, cursor);
        setItems((prev) => (cursor ? [...(prev ?? []), ...res.items] : res.items));
        setNextCursor(res.nextCursor);
      } catch {
        setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void load(state);
  }, [load, state]);

  const switchState = (next: UnattributedOrderState) => {
    setItems(null);
    setActionError(null);
    setState(next);
  };

  const onClaim = async (orderId: string) => {
    if (!token) return;
    const recommendationId = window.prompt(t("admin.orders.claimPrompt"));
    if (!recommendationId) return;
    setBusyOrder(orderId);
    setActionError(null);
    try {
      await adminApi.claimUnattributedOrder(token, orderId, {
        recommendationId: recommendationId.trim(),
      });
      await load(state);
    } catch {
      setActionError(t("admin.orders.actionFailed"));
    } finally {
      setBusyOrder(null);
    }
  };

  const onDismiss = async (orderId: string) => {
    if (!token) return;
    setBusyOrder(orderId);
    setActionError(null);
    try {
      await adminApi.dismissUnattributedOrder(token, orderId);
      await load(state);
    } catch {
      setActionError(t("admin.orders.actionFailed"));
    } finally {
      setBusyOrder(null);
    }
  };

  const dateLocale = i18n.language.startsWith("he") ? "he-IL" : "en-US";
  const fmtDate = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(dateLocale, {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";

  return (
    <div className="max-w-[1080px]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Segmented
          options={STATES.map((s) => ({ value: s, label: t(`admin.orders.state.${s}`) }))}
          value={state}
          onChange={(v) => switchState(v as UnattributedOrderState)}
        />
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(state)}
          className="rounded-tile border border-edge bg-surface px-3 py-1.5 text-[12.5px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("admin.orders.refresh")}
        </button>
      </div>

      {actionError ? <p className="mb-3 text-sm text-red-600">{actionError}</p> : null}

      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full text-start text-[13px]">
          <thead>
            <tr className="border-b border-line text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted">
              <Th>{t("admin.orders.order")}</Th>
              <Th>{t("admin.orders.commission")}</Th>
              <Th>{t("admin.orders.reason")}</Th>
              <Th>{t("admin.orders.platformStatus")}</Th>
              <Th>{t("admin.orders.seen")}</Th>
              <Th>{t("admin.orders.claimCol")}</Th>
              <Th>{t("admin.orders.actions")}</Th>
            </tr>
          </thead>
          <tbody>
            {loading && !items
              ? [0, 1, 2].map((i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    <td colSpan={7} className="px-4 py-3">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  </tr>
                ))
              : null}
            {loadFailed ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted">
                  {t("admin.orders.loadFailed")}
                </td>
              </tr>
            ) : null}
            {items && items.length === 0 && !loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted">
                  {t("admin.orders.empty")}
                </td>
              </tr>
            ) : null}
            {(items ?? []).map((o) => (
              <tr key={o.orderId} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-mono text-[12.5px]" dir="ltr">
                  {o.orderId}
                </td>
                <td className="px-4 py-3 font-semibold" dir="ltr">
                  {o.amount ? formatMoneyMinor(o.amount.amountMinor, o.amount.currency) : "—"}
                </td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-base px-2 py-0.5 text-[11.5px] font-semibold text-muted">
                    {o.reason}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted">{o.orderStatus}</td>
                <td className="px-4 py-3 text-muted">{fmtDate(o.occurredAt ?? o.firstSeenAt)}</td>
                <td className="px-4 py-3 text-muted" dir="ltr">
                  {o.claim
                    ? `${o.claim.recommendationId} · ${o.claim.claimedBy}`
                    : o.settledAt
                      ? fmtDate(o.settledAt)
                      : "—"}
                </td>
                <td className="px-4 py-3">
                  {state === "open" || state === "claimed" ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busyOrder === o.orderId || !o.amount}
                        onClick={() => void onClaim(o.orderId)}
                        className="rounded-tile bg-accent px-2.5 py-1 text-[12px] font-bold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t("admin.orders.claim")}
                      </button>
                      <button
                        type="button"
                        disabled={busyOrder === o.orderId}
                        onClick={() => void onDismiss(o.orderId)}
                        className="rounded-tile border border-edge bg-surface px-2.5 py-1 text-[12px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t("admin.orders.dismiss")}
                      </button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {nextCursor ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(state, nextCursor)}
            className="rounded-tile border border-edge bg-surface px-4 py-2 text-[12.5px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("admin.orders.loadMore")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2.5 text-start font-semibold">{children}</th>;
}
