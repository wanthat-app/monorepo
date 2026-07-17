import type { AdminUserItem } from "@wanthat/contracts";
import { Chip, SearchField, Skeleton, StatusBadge } from "@wanthat/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { adminApi, normalizePhonePrefix } from "../lib/admin-api";
import { ApiError } from "../lib/api";

const PAGE_SIZE = 20;

/**
 * Which action a row's inline confirm is armed for. Every action shares the delete UX: the action
 * cluster swaps to a confirm button + cancel, and any explanatory note renders under the row.
 */
type RowAction = "delete" | "disable" | "enable" | "signout";

/**
 * Admin users page, Cognito-backed (ADR-0006): forward-only "load more" pagination driven by the
 * opaque `nextToken` (no page numbers — the `total` is the approximate WHOLE pool, so page counts
 * cannot be derived from it), phone-PREFIX search (local `05x…` input is normalized to `+9725x…`
 * client-side), and per-row moderation (suspend / unsuspend / sign-out-everywhere, decision 8).
 * Delete is a single step since T7 dropped the Aurora `customer` table: POST cognito-delete
 * (admin-credentials, non-VPC) removes the Cognito account AND the member's recommendations,
 * idempotently — an already-gone account is success, not an error.
 */
export function UsersView({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextToken, setNextToken] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Per-row action flow: which row is in its inline confirm state / busy, and any row-scoped
  // error message (e.g. a failed moderation call).
  const [confirm, setConfirm] = useState<{ id: string; action: RowAction } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // (Re)load the first page for a search term — replaces the list and resets the token walk.
  const load = useCallback(
    async (term: string) => {
      if (!token) return;
      setLoading(true);
      setLoadFailed(false);
      try {
        const res = await adminApi.listUsers(token, {
          search: term ? normalizePhonePrefix(term) : undefined,
          pageSize: PAGE_SIZE,
        });
        setUsers(res.users);
        setTotal(res.total);
        setNextToken(res.nextToken);
      } catch {
        setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  // Forward-only next page: append with the token from the previous response.
  const loadMore = async () => {
    if (!token || !nextToken) return;
    setLoadingMore(true);
    try {
      const res = await adminApi.listUsers(token, {
        search: search ? normalizePhonePrefix(search) : undefined,
        pageSize: PAGE_SIZE,
        nextToken,
      });
      setUsers((prev) => [...prev, ...res.users]);
      setTotal(res.total);
      setNextToken(res.nextToken);
    } catch {
      setWarning(t("admin.usersPage.loadMoreFailed"));
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void load("");
  }, [load]);

  // Debounced search — every term change restarts from the first page.
  const onSearch = (term: string) => {
    setSearch(term);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(term), 350);
  };

  // Single-step erase (T7 dropped the Aurora customer row): the Cognito account plus the
  // member's recommendations go together; `recommendationsDeleted` is echoed into the toast.
  const onDelete = async (user: AdminUserItem) => {
    if (!token) return;
    setBusyId(user.id);
    setRowError(null);
    setWarning(null);
    setNotice(null);
    try {
      const res = await adminApi.cognitoDeleteUser(token, user.phone);
      setNotice(
        res.recommendationsDeleted !== undefined
          ? t("admin.usersPage.deletedWithRecs", { n: res.recommendationsDeleted })
          : t("admin.usersPage.deleted"),
      );
    } catch {
      setRowError({ id: user.id, message: t("admin.usersPage.deleteFailed") });
      setBusyId(null);
      setConfirm(null);
      return;
    }
    setBusyId(null);
    setConfirm(null);
    void load(search);
  };

  // Moderation actions mutate the row in place instead of refetching — a refetch would rewind
  // the forward-only token walk back to the first page.
  const onModerate = async (user: AdminUserItem, action: Exclude<RowAction, "delete">) => {
    if (!token) return;
    setBusyId(user.id);
    setRowError(null);
    setWarning(null);
    setNotice(null);
    try {
      if (action === "disable") await adminApi.disableUser(token, user.phone);
      else if (action === "enable") await adminApi.enableUser(token, user.phone);
      else await adminApi.globalSignOutUser(token, user.phone);
      if (action !== "signout") {
        const status = action === "disable" ? ("suspended" as const) : ("active" as const);
        setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, status } : u)));
      }
      setNotice(
        action === "disable"
          ? t("admin.usersPage.suspendedToast")
          : action === "enable"
            ? t("admin.usersPage.unsuspendedToast")
            : t("admin.usersPage.signedOutToast"),
      );
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setRowError({
        id: user.id,
        message:
          code === "not_found" ? t("admin.usersPage.notFound") : t("admin.usersPage.actionFailed"),
      });
    }
    setBusyId(null);
    setConfirm(null);
  };

  const arm = (user: AdminUserItem, action: RowAction) => {
    setConfirm({ id: user.id, action });
    setRowError(null);
  };

  const runConfirmed = (user: AdminUserItem, action: RowAction) =>
    action === "delete" ? onDelete(user) : onModerate(user, action);

  const confirmLabel = (action: RowAction) =>
    action === "delete"
      ? t("admin.usersPage.confirmDelete")
      : action === "disable"
        ? t("admin.usersPage.confirmSuspend")
        : action === "enable"
          ? t("admin.usersPage.confirmUnsuspend")
          : t("admin.usersPage.confirmSignOut");

  // The stateless-authorizer caveat (ADR-0006 d8): already-issued access tokens survive up to 1 h.
  const confirmNote = (action: RowAction) =>
    action === "disable"
      ? t("admin.usersPage.suspendNote")
      : action === "signout"
        ? t("admin.usersPage.signOutNote")
        : null;

  return (
    <div className="max-w-[960px]">
      <div className="mb-4 flex items-center gap-3">
        <SearchField
          placeholder={t("admin.usersPage.searchPlaceholder")}
          value={search}
          onChange={onSearch}
          width={320}
        />
        {/* The pool count is approximate and WHOLE-pool (Cognito has no filtered count), so it is
            only shown when no search narrows the list — beside a filter it would read as the
            match count, which it is not. */}
        {total !== null && !search ? (
          <span className="tabular text-[13px] text-muted">
            {t("admin.usersPage.approxTotal", { total })}
          </span>
        ) : null}
      </div>

      {notice ? (
        <div className="mb-3 rounded-field border border-accent-border bg-accent-soft px-4 py-2.5 text-[13px] text-accent">
          {notice}
        </div>
      ) : null}

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
          <span className="w-[110px]">{t("admin.usersPage.status")}</span>
          <span className="w-[100px]">{t("admin.usersPage.joined")}</span>
          <span className="w-[130px]" />
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
              <span className="w-[110px] pe-3">
                <Skeleton className="h-6 w-16 rounded-full" />
              </span>
              <span className="w-[100px] pe-3">
                <Skeleton className="h-3.5 w-16" />
              </span>
              <span className="w-[130px]" />
            </div>
          ))
        ) : loadFailed ? (
          <div className="border-t border-hairrow px-4 py-6 text-sm text-rejected">
            {t("admin.usersPage.loadError")}
          </div>
        ) : users.length === 0 ? (
          <div className="border-t border-hairrow px-4 py-6 text-sm text-muted">
            {t("admin.usersPage.empty")}
          </div>
        ) : (
          users.map((user) => {
            const name = `${user.firstName} ${user.lastName}`.trim();
            const armed = confirm !== null && confirm.id === user.id ? confirm.action : null;
            const note = armed ? confirmNote(armed) : null;
            return (
              <div key={user.id} className="border-t border-hairrow px-4 py-3">
                <div className="flex items-center">
                  <span className="flex-[1.2] pe-3">
                    <button
                      type="button"
                      onClick={() => navigate(`/users/${encodeURIComponent(user.id)}`)}
                      className="block max-w-full truncate text-start text-[13.5px] font-semibold text-accent underline-offset-2 hover:underline"
                    >
                      {name || user.phone}
                    </button>
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
                  <span className="flex w-[110px] flex-col items-start gap-1 pe-3">
                    <StatusBadge status={user.status === "active" ? "confirmed" : "pending"}>
                      {user.status === "active"
                        ? t("admin.usersPage.active")
                        : t("admin.usersPage.suspended")}
                    </StatusBadge>
                    {user.userStatus === "UNCONFIRMED" ? (
                      <Chip tone="neutral">{t("admin.usersPage.unconfirmed")}</Chip>
                    ) : null}
                  </span>
                  <span
                    className="tabular w-[100px] pe-3 text-[13px] text-muted rtl:text-right"
                    dir="ltr"
                  >
                    {user.createdAt.slice(0, 10)}
                  </span>
                  <span className="flex w-[130px] items-center justify-end gap-1.5">
                    {armed ? (
                      <>
                        <button
                          type="button"
                          disabled={busyId === user.id}
                          onClick={() => void runConfirmed(user, armed)}
                          className={`rounded-[9px] px-2.5 py-1.5 text-xs font-bold text-white transition disabled:opacity-50 ${
                            armed === "delete"
                              ? "bg-rejected hover:bg-rejected/90"
                              : "bg-ink hover:bg-ink/90"
                          }`}
                        >
                          {confirmLabel(armed)}
                        </button>
                        <button
                          type="button"
                          aria-label={t("admin.usersPage.confirmNo")}
                          disabled={busyId === user.id}
                          onClick={() => setConfirm(null)}
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
                      <>
                        {user.status === "active" ? (
                          <IconButton
                            label={t("admin.usersPage.suspend")}
                            onClick={() => arm(user, "disable")}
                          >
                            {/* ban: circle + slash */}
                            <circle cx="12" cy="12" r="9" />
                            <path d="M5.6 5.6l12.8 12.8" />
                          </IconButton>
                        ) : (
                          <IconButton
                            label={t("admin.usersPage.unsuspend")}
                            onClick={() => arm(user, "enable")}
                          >
                            {/* undo-ban: circle + check */}
                            <circle cx="12" cy="12" r="9" />
                            <path d="M8.5 12.2l2.4 2.4 4.6-4.8" />
                          </IconButton>
                        )}
                        <IconButton
                          label={t("admin.usersPage.signOut")}
                          onClick={() => arm(user, "signout")}
                        >
                          {/* log-out */}
                          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                          <path d="M16 17l5-5-5-5" />
                          <path d="M21 12H9" />
                        </IconButton>
                        <IconButton
                          label={t("admin.usersPage.delete")}
                          danger
                          onClick={() => arm(user, "delete")}
                        >
                          {/* trash */}
                          <path d="M3 6h18" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                        </IconButton>
                      </>
                    )}
                  </span>
                </div>
                {note ? <div className="pt-1.5 text-end text-xs text-muted">{note}</div> : null}
                {rowError !== null && rowError.id === user.id ? (
                  <div className="pt-1.5 text-end text-xs text-rejected">{rowError.message}</div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* Forward-only pagination: Cognito's PaginationToken cannot walk backwards, so there is a
          single "load more" that appends the next page while a token remains. */}
      {nextToken && !loading && !loadFailed ? (
        <div className="mt-4 flex items-center justify-end">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            className="rounded-tile border border-edge bg-surface px-4 py-2 text-[13px] font-bold text-ink transition hover:bg-base disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? t("admin.usersPage.loadingMore") : t("admin.usersPage.loadMore")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Row action icon button — the 30px bordered square the delete action already used. */
function IconButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border border-line bg-surface text-muted transition ${
        danger ? "hover:border-rejected/40 hover:text-rejected" : "hover:border-edge hover:text-ink"
      }`}
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
        {children}
      </svg>
    </button>
  );
}
