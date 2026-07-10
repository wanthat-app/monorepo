import type { UnattributedOrderView } from "@wanthat/contracts";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { adminApi } from "../../lib/admin-api";
import { formatMoneyMinor } from "../../lib/money";
import { Button, Skeleton } from "../../ui/components";

/**
 * Admin order detail (portal cross-reference): everything the poll saw about one unattributed
 * order — the product (image/title/link), the ids the AliExpress portal report keys by
 * (order id + sub-order id), amounts and rate, timestamps, and the claim lifecycle with the
 * same claim/dismiss actions as the list. Data is the projection item; a re-sighting refreshes
 * it on the next poll.
 */
export function OrderDetailView({ token, orderId }: { token: string | null; orderId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [item, setItem] = useState<UnattributedOrderView | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "failed">("loading");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setStatus("loading");
    try {
      const res = await adminApi.getUnattributedOrder(token, orderId);
      setItem(res.item);
      setStatus("ready");
    } catch (err) {
      setStatus((err as { status?: number }).status === 404 ? "missing" : "failed");
    }
  }, [token, orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onClaim = async () => {
    if (!token) return;
    const recommendationId = window.prompt(t("admin.orders.claimPrompt"));
    if (!recommendationId) return;
    setBusy(true);
    setActionError(null);
    try {
      await adminApi.claimUnattributedOrder(token, orderId, {
        recommendationId: recommendationId.trim(),
      });
      await load();
    } catch {
      setActionError(t("admin.orders.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const onDismiss = async () => {
    if (!token) return;
    setBusy(true);
    setActionError(null);
    try {
      await adminApi.dismissUnattributedOrder(token, orderId);
      await load();
    } catch {
      setActionError(t("admin.orders.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const dateLocale = i18n.language.startsWith("he") ? "he-IL" : "en-US";
  const fmtDate = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(dateLocale, {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";

  // The detail URL is external API data flowing into an href: only http(s) may render — a
  // javascript: value would execute in the admin's session.
  const safeHttp = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);
  const productUrl =
    safeHttp(item?.product?.detailUrl) ??
    (item?.product?.productId
      ? `https://www.aliexpress.com/item/${encodeURIComponent(item.product.productId)}.html`
      : null);

  return (
    <div className="max-w-[880px]">
      <button
        type="button"
        onClick={() => navigate("/admin/orders")}
        className="mb-4 text-[13px] font-bold text-accent"
      >
        ‹ {t("admin.orders.backToList")}
      </button>

      {status === "loading" ? (
        <div className="rounded-card border border-line bg-surface p-6">
          <Skeleton className="mb-3 h-6 w-2/3" />
          <Skeleton className="mb-2 h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      ) : null}
      {status === "missing" ? (
        <p className="text-sm text-muted">{t("admin.orders.notFound")}</p>
      ) : null}
      {status === "failed" ? (
        <p className="text-sm text-muted">{t("admin.orders.loadFailed")}</p>
      ) : null}

      {status === "ready" && item ? (
        <div className="flex flex-col gap-4">
          {/* Product card */}
          <div className="flex gap-5 rounded-card border border-line bg-surface p-5">
            {item.product?.imageUrl ? (
              <img
                src={item.product.imageUrl}
                alt={item.product.title ?? ""}
                referrerPolicy="no-referrer"
                className="h-[132px] w-[132px] shrink-0 rounded-thumb border border-line object-contain"
              />
            ) : (
              <div className="flex h-[132px] w-[132px] shrink-0 items-center justify-center rounded-thumb border border-line text-xs text-muted">
                {t("admin.orders.noImage")}
              </div>
            )}
            <div className="min-w-0">
              <h2 className="text-[16px] font-bold leading-snug text-ink">
                {item.product?.title ?? t("admin.orders.unknownProduct")}
              </h2>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
                <Dt>{t("admin.orders.productId")}</Dt>
                <Dd mono>{item.product?.productId ?? "—"}</Dd>
                <Dt>{t("admin.orders.quantity")}</Dt>
                <Dd>{item.product?.count ?? "—"}</Dd>
              </dl>
              {productUrl ? (
                <a
                  href={productUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-block text-[13px] font-bold text-accent"
                >
                  {t("admin.orders.openProduct")} ↗
                </a>
              ) : null}
            </div>
          </div>

          {/* Portal cross-reference */}
          <div className="rounded-card border border-line bg-surface p-5">
            <h3 className="mb-3 text-[14px] font-bold text-ink">{t("admin.orders.portalRef")}</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]">
              <Dt>{t("admin.orders.order")}</Dt>
              <Dd mono>{item.orderId}</Dd>
              <Dt>{t("admin.orders.subOrder")}</Dt>
              <Dd mono>{item.subOrderId ?? "—"}</Dd>
              <Dt>{t("admin.orders.paidAmount")}</Dt>
              <Dd>
                {item.paidAmount
                  ? formatMoneyMinor(item.paidAmount.amountMinor, item.paidAmount.currency)
                  : "—"}
              </Dd>
              <Dt>{t("admin.orders.commission")}</Dt>
              <Dd>
                {item.amount
                  ? formatMoneyMinor(item.amount.amountMinor, item.amount.currency)
                  : "—"}
                {item.commissionRate ? ` (${item.commissionRate})` : ""}
              </Dd>
              <Dt>{t("admin.orders.platformStatus")}</Dt>
              <Dd>{item.orderStatus}</Dd>
              <Dt>{t("admin.orders.orderTime")}</Dt>
              <Dd>{fmtDate(item.occurredAt)}</Dd>
              <Dt>{t("admin.orders.firstSeen")}</Dt>
              <Dd>{fmtDate(item.firstSeenAt)}</Dd>
              <Dt>{t("admin.orders.lastSeen")}</Dt>
              <Dd>{fmtDate(item.lastSeenAt)}</Dd>
            </dl>
          </div>

          {/* Attribution lifecycle + actions */}
          <div className="rounded-card border border-line bg-surface p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[14px] font-bold text-ink">{t("admin.orders.attribution")}</h3>
              <span className="rounded-full bg-base px-2.5 py-1 text-[11.5px] font-bold text-muted">
                {t(`admin.orders.state.${item.state}`)} · {item.reason}
              </span>
            </div>
            {item.claim ? (
              <p className="mb-3 text-[13px] text-muted" dir="ltr">
                {item.claim.recommendationId} · {item.claim.claimedBy} ·{" "}
                {fmtDate(item.claim.claimedAt)}
                {item.settledAt
                  ? ` → ${t("admin.orders.state.settled")} ${fmtDate(item.settledAt)}`
                  : ""}
              </p>
            ) : (
              <p className="mb-3 text-[13px] text-muted">{t("admin.orders.noClaim")}</p>
            )}
            {actionError ? <p className="mb-3 text-sm text-red-600">{actionError}</p> : null}
            {item.state === "open" || item.state === "claimed" ? (
              <div className="flex gap-2">
                <Button disabled={busy || !item.amount} onClick={() => void onClaim()}>
                  {t("admin.orders.claim")}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void onDismiss()}>
                  {t("admin.orders.dismiss")}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="font-semibold text-muted">{children}</dt>;
}

function Dd({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <dd className={mono ? "font-mono text-[12.5px] text-ink" : "text-ink"} dir="ltr">
      {children}
    </dd>
  );
}
