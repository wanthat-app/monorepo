import type { ActivityItem } from "@wanthat/contracts";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { adminApi } from "../../lib/admin-api";
import { Skeleton } from "../../ui/components";

const PAGE_SIZE = 20;

/**
 * Admin activity page: one paged feed over the audit log (registrations, deletions, future
 * audited admin actions), newest first. In dev the server merges live OTP codes from the dev
 * sink into page 1 (type "otp_sent" — never present in prod). Unknown event types render with
 * a neutral badge and the raw type string, so new audit events appear without SPA changes.
 */
export function ActivityView({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: ActivityItem[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(
    async (pageNo: number) => {
      if (!token) return;
      setLoading(true);
      setLoadFailed(false);
      try {
        const res = await adminApi.listActivity(token, { page: pageNo, pageSize: PAGE_SIZE });
        setData({ items: res.items, total: res.total });
      } catch {
        setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  const goTo = (pageNo: number) => {
    setPage(pageNo);
    void load(pageNo);
  };

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="max-w-[960px]">
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(page)}
          className="flex items-center gap-1.5 rounded-tile border border-edge bg-surface px-3 py-1.5 text-[12.5px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
          {t("admin.activityPage.refresh")}
        </button>
        {data ? (
          <span className="tabular text-[13px] text-muted">
            {t("admin.activityPage.pageOf", { page, pages, total: data.total })}
          </span>
        ) : null}
      </div>

      <div className="rounded-card border border-line bg-surface pb-1">
        <div className="flex items-center px-4 pb-2 pt-4 text-[11px] font-bold uppercase tracking-[0.04em] text-placeholder">
          <span className="w-[110px]">{t("admin.activityPage.time")}</span>
          <span className="w-[160px]">{t("admin.activityPage.event")}</span>
          <span className="flex-1">{t("admin.activityPage.user")}</span>
          <span className="flex-[1.3]">{t("admin.activityPage.details")}</span>
        </div>

        {loading ? (
          [0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="flex items-center border-t border-hairrow px-4 py-3"
              aria-busy="true"
            >
              <span className="w-[110px] pe-3">
                <Skeleton className="h-3.5 w-16" />
              </span>
              <span className="w-[160px] pe-3">
                <Skeleton className="h-6 w-24 rounded-full" />
              </span>
              <span className="flex-1 pe-3">
                <Skeleton className="h-3.5 w-36" />
              </span>
              <span className="flex-[1.3] pe-3">
                <Skeleton className="h-3.5 w-44" />
              </span>
            </div>
          ))
        ) : loadFailed ? (
          <div className="flex items-center gap-3 border-t border-hairrow px-4 py-6 text-sm text-rejected">
            {t("admin.activityPage.loadError")}
            <button
              type="button"
              onClick={() => void load(page)}
              className="rounded-tile border border-edge bg-surface px-3 py-1.5 text-[12.5px] font-bold text-ink transition hover:bg-base"
            >
              {t("admin.activityPage.retry")}
            </button>
          </div>
        ) : data && data.items.length === 0 ? (
          <div className="border-t border-hairrow px-4 py-6 text-sm text-muted">
            {t("admin.activityPage.empty")}
          </div>
        ) : (
          data?.items.map((item) => <ActivityRow key={item.id} item={item} />)
        )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2.5">
        <button
          type="button"
          disabled={loading || page <= 1}
          onClick={() => goTo(page - 1)}
          className="rounded-tile border border-edge bg-surface px-4 py-2 text-[13px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("admin.activityPage.prev")}
        </button>
        <button
          type="button"
          disabled={loading || page >= pages}
          onClick={() => goTo(page + 1)}
          className="rounded-tile border border-edge bg-surface px-4 py-2 text-[13px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("admin.activityPage.next")}
        </button>
      </div>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const d = new Date(item.at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <div className="flex items-center border-t border-hairrow px-4 py-3">
      {/* dir="ltr" keeps time/phone glyph order; rtl:text-right re-aligns the cell with its
          column header when the page direction is RTL. */}
      <span className="tabular w-[110px] pe-3 text-[13px] rtl:text-right" dir="ltr">
        <span className="block font-semibold text-ink">{time}</span>
        <span className="text-muted">{date}</span>
      </span>
      <span className="w-[160px] pe-3">
        <EventBadge type={item.type} />
      </span>
      <span className="min-w-0 flex-1 pe-3">
        {item.name ? (
          <span className="block truncate text-[13.5px] font-semibold text-ink">{item.name}</span>
        ) : null}
        {item.phone ? (
          <span className="tabular block text-[12.5px] text-muted rtl:text-right" dir="ltr">
            {item.phone}
          </span>
        ) : null}
        {!item.name && !item.phone ? <span className="text-[13px] text-muted">—</span> : null}
      </span>
      <span className="flex min-w-0 flex-[1.3] flex-wrap items-center gap-2 pe-3 text-[13px] text-muted">
        <Details item={item} />
      </span>
    </div>
  );
}

function Details({ item }: { item: ActivityItem }) {
  const { t } = useTranslation();

  if (item.type === "otp_sent") {
    const minutesLeft = item.expiresAt
      ? Math.max(0, Math.round((new Date(item.expiresAt).getTime() - Date.now()) / 60_000))
      : null;
    return (
      <>
        <span className="font-semibold text-secondary">
          {item.channel === "whatsapp" ? "WhatsApp" : "SMS"}
        </span>
        {item.code ? (
          <span
            className="tabular rounded-[9px] border border-edge bg-base px-2.5 py-1 font-mono text-[13px] font-bold tracking-[0.12em] text-ink"
            dir="ltr"
          >
            {item.code}
          </span>
        ) : null}
        {minutesLeft !== null ? (
          <span className="text-[11.5px] text-placeholder">
            {minutesLeft > 0
              ? t("admin.activityPage.expiresIn", { minutes: minutesLeft })
              : t("admin.activityPage.expired")}
          </span>
        ) : null}
      </>
    );
  }

  if (item.type === "user_deleted" && item.actor) {
    return (
      <span>
        {t("admin.activityPage.deletedBy", { actor: item.actor })}
        <span className="text-placeholder"> · {item.id.replace("audit_", "#")}</span>
      </span>
    );
  }

  if (item.type === "config_changed" && item.key) {
    return (
      <>
        <span
          className="rounded-[9px] border border-edge bg-base px-2 py-0.5 font-mono text-[12px] font-semibold text-ink"
          dir="ltr"
        >
          {item.key}
        </span>
        <span className="tabular" dir="ltr">
          {configValue(item.previous)} → {configValue(item.value)}
        </span>
        {item.actor ? (
          <span className="text-[11.5px] text-placeholder">
            {t("admin.activityPage.byActor", { actor: item.actor })}
          </span>
        ) : null}
      </>
    );
  }

  return <span>—</span>;
}

/** Config values are free JSON (booleans, numbers, strings): compact one-line display. */
function configValue(v: unknown): string {
  if (v === undefined) return "—";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function EventBadge({ type }: { type: string }) {
  const { t } = useTranslation();

  if (type === "user_registered") {
    return (
      <Badge className="bg-accent-soft text-accent">{t("admin.activityPage.registered")}</Badge>
    );
  }
  if (type === "user_deleted") {
    return (
      <Badge className="bg-rejected-soft text-rejected">{t("admin.activityPage.deleted")}</Badge>
    );
  }
  if (type === "config_changed") {
    return (
      <Badge className="bg-bank-soft text-bank">{t("admin.activityPage.configChanged")}</Badge>
    );
  }
  if (type === "otp_sent") {
    return (
      <Badge className="bg-pending-soft text-pending">
        {t("admin.activityPage.otpSent")}
        <span className="ms-0.5 rounded-md bg-pending px-1.5 py-px text-[10px] font-extrabold tracking-[0.08em] text-white">
          {t("admin.activityPage.dev")}
        </span>
      </Badge>
    );
  }
  // Unknown/future audit types render generically - new events need no SPA change.
  return <Badge className="bg-base text-secondary">{type}</Badge>;
}

function Badge({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] font-bold ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
