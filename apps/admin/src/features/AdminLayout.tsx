import { BrandMark, Segmented } from "@wanthat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export type AdminView = "dashboard" | "users" | "orders" | "config" | "activity";

/**
 * Admin console chrome (Wanthat Admin): a fixed light sidebar + a topbar, with the active view rendered
 * as children. Built from logical properties so the whole shell mirrors in RTL — the sidebar moves to
 * the inline-start edge and directional glyphs flip. Colours/spacing follow the design mock's light
 * sidebar theme (surface white + hairline borders, evergreen active nav, 248px rail, 16/32 topbar padding).
 */
export function AdminLayout({
  view,
  onNavigate,
  title,
  subtitle,
  user,
  onSignOut,
  children,
}: {
  view: AdminView;
  onNavigate: (view: AdminView) => void;
  title: string;
  subtitle: string;
  user: { name: string; role: string };
  onSignOut: () => void;
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="flex h-screen overflow-hidden bg-[#e9edeb] font-body text-ink">
      {/* ============ SIDEBAR ============ */}
      <aside className="flex w-[248px] flex-shrink-0 flex-col border-e border-line bg-surface px-[18px] py-6">
        <div className="flex items-center gap-3 px-1.5 pt-1">
          <BrandMark />
          <div>
            <div className="font-display text-[21px] font-bold leading-none tracking-[-0.03em] text-ink">
              {t("admin.brand")}
            </div>
            <div className="mt-[3px] text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              {t("admin.operations")}
            </div>
          </div>
        </div>

        <div className="my-5 h-px bg-line" />

        <NavLabel>{t("admin.overview")}</NavLabel>
        <NavItem active={view === "dashboard"} onClick={() => onNavigate("dashboard")}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <title>{t("admin.dashboard")}</title>
            <rect x="3" y="3" width="7" height="9" rx="1.5" />
            <rect x="14" y="3" width="7" height="5" rx="1.5" />
            <rect x="14" y="12" width="7" height="9" rx="1.5" />
            <rect x="3" y="16" width="7" height="5" rx="1.5" />
          </svg>
          {t("admin.dashboard")}
        </NavItem>
        <NavItem active={view === "users"} onClick={() => onNavigate("users")}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <title>{t("admin.usersNav")}</title>
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          {t("admin.usersNav")}
        </NavItem>
        <NavItem active={view === "orders"} onClick={() => onNavigate("orders")}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <title>{t("admin.ordersNav")}</title>
            <path d="M21 8v13H3V8" />
            <path d="M1 3h22v5H1z" />
            <path d="M10 12h4" />
          </svg>
          {t("admin.ordersNav")}
        </NavItem>
        <NavItem active={view === "activity"} onClick={() => onNavigate("activity")}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <title>{t("admin.activityNav")}</title>
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          {t("admin.activityNav")}
        </NavItem>

        <div className="mt-5">
          <NavLabel>{t("admin.settings")}</NavLabel>
        </div>
        <NavItem active={view === "config"} onClick={() => onNavigate("config")}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <title>{t("admin.configuration")}</title>
            <path d="M4 6h10" />
            <circle cx="17" cy="6" r="2.4" />
            <path d="M20 12H10" />
            <circle cx="7" cy="12" r="2.4" />
            <path d="M4 18h10" />
            <circle cx="17" cy="18" r="2.4" />
          </svg>
          {t("admin.configuration")}
        </NavItem>

        <div className="mt-auto flex flex-col gap-3 pt-[18px]">
          <Segmented
            value={i18n.language.startsWith("he") ? "he" : "en"}
            onChange={(lng) => void i18n.changeLanguage(lng)}
            options={[
              { value: "en", label: "English" },
              { value: "he", label: "עברית" },
            ]}
          />
          <div className="flex items-center gap-2.5 rounded-[14px] border border-line bg-base px-3 py-2.5">
            <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[11px] bg-accent text-sm font-bold text-white">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-bold text-ink">{user.name}</div>
              <div className="text-[11px] text-muted">{user.role}</div>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              aria-label={t("admin.signOut")}
              title={t("admin.signOut")}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition hover:bg-line hover:text-ink"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className="rtl:-scale-x-100"
              >
                <title>{t("admin.signOut")}</title>
                <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
                <path d="M16 17l5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* ============ MAIN ============ */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-shrink-0 items-center gap-5 border-b border-[#e2e7e4] bg-surface px-8 py-4">
          <div className="min-w-0">
            <h1 className="m-0 font-display text-[23px] font-bold leading-[1.1] tracking-[-0.025em]">
              {title}
            </h1>
            <div className="mt-[3px] text-[13px] text-muted">{subtitle}</div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-8 pb-16 pt-7">{children}</main>
      </div>
    </div>
  );
}

function NavLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-1.5 pb-2.5 text-[10.5px] font-bold uppercase tracking-[0.13em] text-muted">
      {children}
    </div>
  );
}

function NavItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start text-sm font-bold transition ${
        active
          ? "bg-accent text-white"
          : "bg-transparent text-secondary hover:bg-base hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
