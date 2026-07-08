import type { CustomerProfile } from "@wanthat/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { adminApi } from "../../lib/admin-api";
import { ApiError } from "../../lib/api";
import { SearchField } from "../../ui/admin";
import { Skeleton, StatusBadge } from "../../ui/components";

const PAGE_SIZE = 20;

/**
 * Admin users page: paged, searchable (phone/email) customer list with a guarded hard delete.
 * Delete is two steps orchestrated here — the Aurora row first (admin-api owns the wallet-history
 * guard: 409 `has_wallet_history`), then the Cognito account (admin-credentials, non-VPC). A failed
 * second step is surfaced as a warning, not an error: the leftover Cognito account holds only the
 * phone and is reused by the idempotent registration flow.
 */
export function UsersView({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ users: CustomerProfile[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  // Per-row delete flow: which row is in its inline confirm state / being deleted, and any
  // row-scoped error message (e.g. the wallet-history refusal).
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(
    async (term: string, pageNo: number) => {
      if (!token) return;
      setLoading(true);
      setLoadFailed(false);
      try {
        const res = await adminApi.listUsers(token, {
          search: term || undefined,
          page: pageNo,
          pageSize: PAGE_SIZE,
        });
        setData({ users: res.users, total: res.total });
      } catch {
        setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void load("", 1);
  }, [load]);

  // Debounced search — resets to page 1 on every term change.
  const onSearch = (term: string) => {
    setSearch(term);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      void load(term, 1);
    }, 350);
  };

  const goTo = (pageNo: number) => {
    setPage(pageNo);
    void load(search, pageNo);
  };

  const onDelete = async (user: CustomerProfile) => {
    if (!token) return;
    setBusyId(user.id);
    setRowError(null);
    setWarning(null);
    try {
      await adminApi.deleteUser(token, user.id);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setRowError({
        id: user.id,
        message:
          code === "has_wallet_history"
            ? t("admin.usersPage.hasWalletHistory")
            : t("admin.usersPage.deleteFailed"),
      });
      setBusyId(null);
      setConfirmId(null);
      return;
    }
    // Row gone — clean up the sign-in account. A failure here is a warning, not a rollback:
    // the leftover Cognito account is inert and reused on re-registration.
    try {
      await adminApi.cognitoDeleteUser(token, user.phone);
    } catch {
      setWarning(t("admin.usersPage.cognitoCleanupFailed"));
    }
    setBusyId(null);
    setConfirmId(null);
    void load(search, page);
  };

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="max-w-[960px]">
      <div className="mb-4 flex items-center gap-3">
        <SearchField
          placeholder={t("admin.usersPage.searchPlaceholder")}
          value={search}
          onChange={onSearch}
          width={320}
        />
        {data ? (
          <span className="tabular text-[13px] text-muted">
            {t("admin.usersPage.pageOf", { page, pages, total: data.total })}
          </span>
        ) : null}
      </div>

      {warning ? (
        <div className="mb-3 rounded-field border border-pending/40 bg-pending-soft px-4 py-2.5 text-[13px] text-pending">
          {warning}
        </div>
      ) : null}

      <div className="rounded-card border border-line bg-surface pb-1">
        <div className="flex items-center px-4 pb-2 pt-4 text-[11px] font-bold uppercase tracking-[0.04em] text-placeholder">
          <span className="flex-[1.2]">{t("admin.usersPage.name")}</span>
          <span className="w-[150px]">{t("admin.usersPage.phone")}</span>
          <span className="flex-1">{t("admin.usersPage.email")}</span>
          <span className="w-[100px]">{t("admin.usersPage.status")}</span>
          <span className="w-[100px]">{t("admin.usersPage.joined")}</span>
          <span className="w-[110px]" />
        </div>

        {loading ? (
          [0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="flex items-center border-t border-hairrow px-4 py-3"
              aria-busy="true"
            >
              <span className="flex-[1.2] pe-3">
                <Skeleton className="h-3.5 w-32" />
              </span>
              <span className="w-[150px] pe-3">
                <Skeleton className="h-3.5 w-28" />
              </span>
              <span className="flex-1 pe-3">
                <Skeleton className="h-3.5 w-40" />
              </span>
              <span className="w-[100px] pe-3">
                <Skeleton className="h-6 w-16 rounded-full" />
              </span>
              <span className="w-[100px] pe-3">
                <Skeleton className="h-3.5 w-16" />
              </span>
              <span className="w-[110px]" />
            </div>
          ))
        ) : loadFailed ? (
          <div className="border-t border-hairrow px-4 py-6 text-sm text-rejected">
            {t("admin.usersPage.loadError")}
          </div>
        ) : data && data.users.length === 0 ? (
          <div className="border-t border-hairrow px-4 py-6 text-sm text-muted">
            {t("admin.usersPage.empty")}
          </div>
        ) : (
          data?.users.map((user) => (
            <div key={user.id} className="border-t border-hairrow px-4 py-3">
              <div className="flex items-center">
                <span className="flex-[1.2] pe-3">
                  <span className="block truncate text-[13.5px] font-semibold text-ink">
                    {user.firstName} {user.lastName}
                  </span>
                </span>
                {/* dir="ltr" keeps phone/email/date glyph order; rtl:text-right re-aligns the cell
                    with its column header when the page direction is RTL. */}
                <span
                  className="tabular w-[150px] pe-3 text-[13px] text-ink rtl:text-right"
                  dir="ltr"
                >
                  {user.phone}
                </span>
                <span
                  className="flex-1 truncate pe-3 text-[13px] text-muted rtl:text-right"
                  dir="ltr"
                >
                  {user.email ?? "—"}
                </span>
                <span className="w-[100px] pe-3">
                  <StatusBadge status={user.status === "active" ? "confirmed" : "pending"}>
                    {user.status === "active"
                      ? t("admin.usersPage.active")
                      : t("admin.usersPage.suspended")}
                  </StatusBadge>
                </span>
                <span
                  className="tabular w-[100px] pe-3 text-[13px] text-muted rtl:text-right"
                  dir="ltr"
                >
                  {user.createdAt.slice(0, 10)}
                </span>
                <span className="flex w-[110px] items-center justify-end gap-1.5">
                  {confirmId === user.id ? (
                    <>
                      <button
                        type="button"
                        disabled={busyId === user.id}
                        onClick={() => void onDelete(user)}
                        className="rounded-[9px] bg-rejected px-2.5 py-1.5 text-xs font-bold text-white transition hover:bg-rejected/90 disabled:opacity-50"
                      >
                        {t("admin.usersPage.confirmDelete")}
                      </button>
                      <button
                        type="button"
                        aria-label={t("admin.usersPage.confirmNo")}
                        disabled={busyId === user.id}
                        onClick={() => setConfirmId(null)}
                        className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border border-line bg-surface text-muted transition hover:text-ink"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label={t("admin.usersPage.delete")}
                      title={t("admin.usersPage.delete")}
                      onClick={() => {
                        setConfirmId(user.id);
                        setRowError(null);
                      }}
                      className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border border-line bg-surface text-muted transition hover:border-rejected/40 hover:text-rejected"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M3 6h18" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6M14 11v6" />
                      </svg>
                    </button>
                  )}
                </span>
              </div>
              {rowError?.id === user.id ? (
                <div className="pt-1.5 text-end text-xs text-rejected">{rowError.message}</div>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2.5">
        <button
          type="button"
          disabled={loading || page <= 1}
          onClick={() => goTo(page - 1)}
          className="rounded-tile border border-edge bg-surface px-4 py-2 text-[13px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("admin.usersPage.prev")}
        </button>
        <button
          type="button"
          disabled={loading || page >= pages}
          onClick={() => goTo(page + 1)}
          className="rounded-tile border border-edge bg-surface px-4 py-2 text-[13px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("admin.usersPage.next")}
        </button>
      </div>
    </div>
  );
}
