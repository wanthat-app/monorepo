import type { ConfigItem, ConfigKey, ConfigValue } from "@wanthat/contracts";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { adminApi, type StatsOverview } from "../../lib/admin-api";
import {
  beginAdminLogin,
  clearAdminTokens,
  isAdminSession,
  loadAdminTokens,
} from "../../lib/admin-login";
import { identityFromIdToken } from "../../lib/jwt";
import { Button, RangeSlider, Segmented, Spinner, Switch } from "../../ui/components";
import { AdminLayout, type AdminView } from "./AdminLayout";

/**
 * Admin console (Wanthat Admin). A sidebar + topbar shell over two views: a Dashboard (the live users
 * KPI plus placeholder stats) and a Configuration editor that maps the typed config keys onto sliders,
 * a segmented FX-source toggle and switches, batching all dirty keys through a single save bar.
 *
 * Authenticated against the **employee** Cognito pool (ADR-0020 §two-pool), separate from the customer
 * session: an admin token is obtained via the employee hosted UI (`/admin/callback`). Without one we
 * redirect to that login; the `admin` group gates the UI client-side and admin-api re-enforces it. The
 * layout follows the document direction (RTL for Hebrew, the default) via logical properties.
 */
export function AdminPage() {
  const { t } = useTranslation();
  const tokens = loadAdminTokens();
  const [view, setView] = useState<AdminView>("dashboard");

  // No admin token yet → bounce to the employee hosted UI (email + password + TOTP).
  useEffect(() => {
    if (!tokens) void beginAdminLogin();
  }, [tokens]);

  if (!tokens) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!isAdminSession(tokens)) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted">
        {t("admin.notAuthorised")}
      </div>
    );
  }

  const signOut = () => {
    clearAdminTokens();
    void beginAdminLogin();
  };

  const identity = identityFromIdToken(tokens.idToken);
  const isDashboard = view === "dashboard";

  return (
    <AdminLayout
      view={view}
      onNavigate={setView}
      title={isDashboard ? t("admin.dashboard") : t("admin.configuration")}
      subtitle={isDashboard ? t("admin.dashboardSub") : t("admin.configSub")}
      showSearch={isDashboard}
      user={{ name: identity.name ?? identity.email ?? t("admin.you"), role: t("admin.role") }}
      onSignOut={signOut}
    >
      {isDashboard ? (
        <DashboardView token={tokens.accessToken} />
      ) : (
        <ConfigView token={tokens.accessToken} />
      )}
    </AdminLayout>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function DashboardView({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<StatsOverview | null>(null);
  useEffect(() => {
    if (token)
      adminApi
        .statsOverview(token)
        .then(setStats)
        .catch(() => setStats(null));
  }, [token]);

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label={t("admin.stats.cashback")}
          value="—"
          icon={<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />}
        />
        <KpiCard
          label={t("admin.stats.pending")}
          value="—"
          tone="pending"
          icon={
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </>
          }
        />
        <KpiCard
          label={t("admin.stats.users")}
          value={stats ? stats.usersCount.toLocaleString("en-US") : "…"}
          live
          icon={
            <>
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            </>
          }
        />
        <KpiCard
          label={t("admin.stats.conversions")}
          value="—"
          icon={
            <>
              <path d="M3 17l6-6 4 4 7-7" />
              <path d="M14 8h6v6" />
            </>
          }
        />
      </div>

      {/* Charts, approvals queue and top links are deferred to a later slice. */}
      <div className="flex flex-col items-center justify-center gap-1.5 rounded-card border border-dashed border-line bg-surface/60 px-6 py-16 text-center">
        <div className="font-display text-lg font-semibold text-ink">{t("admin.comingSoon")}</div>
        <div className="max-w-sm text-sm text-muted">{t("admin.comingSoonHint")}</div>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  icon,
  live,
  tone = "accent",
}: {
  label: string;
  value: string;
  icon: ReactNode;
  live?: boolean;
  tone?: "accent" | "pending";
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-[18px] border border-line bg-surface p-[18px]">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-semibold text-muted">{label}</span>
        <span
          className={`flex h-[30px] w-[30px] items-center justify-center rounded-[9px] ${
            tone === "pending" ? "bg-[#faf3e6] text-pending" : "bg-accent-soft text-accent"
          }`}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <title>{label}</title>
            {icon}
          </svg>
        </span>
      </div>
      <div className="tabular mt-3 text-[30px] font-display font-bold leading-none tracking-[-0.03em]">
        {value}
      </div>
      {live ? (
        <div className="mt-2.5 flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span className="text-[11.5px] font-semibold text-accent">{t("admin.live")}</span>
        </div>
      ) : (
        <div className="mt-2.5 text-[11.5px] text-subtle">&nbsp;</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type SectionId = "margins" | "payouts" | "automation";
type Control = "percent" | "number" | "fxProvider" | "switch";

interface FieldMeta {
  key: ConfigKey;
  section: SectionId;
  control: Control;
  min?: number;
  max?: number;
  step?: number;
  unit?: "minutes" | "hours" | "sends";
}

// Bounds mirror the per-key zod schemas in @wanthat/contracts (config/keys.ts). The control choice is
// editorial: bps splits read best as percentage sliders, the FX source as a segmented toggle, the SMS
// kill switch as a switch, and the interval/threshold integers as bounded number fields.
const FIELDS: FieldMeta[] = [
  {
    key: "cashback.referrerBps",
    section: "margins",
    control: "percent",
    min: 0,
    max: 10000,
    step: 50,
  },
  {
    key: "cashback.consumerBps",
    section: "margins",
    control: "percent",
    min: 0,
    max: 10000,
    step: 50,
  },
  {
    key: "fx.conversionCommissionBps",
    section: "margins",
    control: "percent",
    min: 0,
    max: 10000,
    step: 50,
  },
  { key: "fx.provider", section: "payouts", control: "fxProvider" },
  {
    key: "fx.updateIntervalMinutes",
    section: "payouts",
    control: "number",
    min: 1,
    max: 1440,
    unit: "minutes",
  },
  {
    key: "poller.intervalMinutes",
    section: "automation",
    control: "number",
    min: 1,
    max: 1440,
    unit: "minutes",
  },
  {
    key: "poller.lookbackHours",
    section: "automation",
    control: "number",
    min: 1,
    max: 2160,
    unit: "hours",
  },
  { key: "auth.smsEnabled", section: "automation", control: "switch" },
  {
    key: "auth.smsMaxPerWindow",
    section: "automation",
    control: "number",
    min: 1,
    max: 20,
    unit: "sends",
  },
  {
    key: "auth.smsLockoutMinutes",
    section: "automation",
    control: "number",
    min: 1,
    max: 1440,
    unit: "minutes",
  },
];

const SECTIONS: { id: SectionId; titleKey: string; descKey: string }[] = [
  { id: "margins", titleKey: "admin.sections.marginsTitle", descKey: "admin.sections.marginsDesc" },
  { id: "payouts", titleKey: "admin.sections.payoutsTitle", descKey: "admin.sections.payoutsDesc" },
  {
    id: "automation",
    titleKey: "admin.sections.automationTitle",
    descKey: "admin.sections.automationDesc",
  },
];

function ConfigView({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ConfigItem[] | null>(null);
  const [draft, setDraft] = useState<Record<string, ConfigValue>>({});
  const [loadError, setLoadError] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");

  const load = useCallback(() => {
    if (!token) return;
    adminApi
      .listConfig(token)
      .then((r) => {
        setItems(r.items);
        setDraft(Object.fromEntries(r.items.map((i) => [i.key, i.value])));
        setLoadError(false);
      })
      .catch(() => setLoadError(true));
  }, [token]);
  useEffect(load, [load]);

  // Original values keyed for dirty-checking; only keys the API returned are editable.
  const original = useMemo(
    () => Object.fromEntries((items ?? []).map((i) => [i.key, i.value])),
    [items],
  );
  const dirtyKeys = useMemo(
    () => Object.keys(original).filter((k) => draft[k] !== original[k]) as ConfigKey[],
    [original, draft],
  );

  const setValue = (key: ConfigKey, value: ConfigValue) => {
    setState("idle");
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const discard = () => {
    setDraft(original);
    setState("idle");
  };
  const save = async () => {
    if (!token || dirtyKeys.length === 0) return;
    setState("saving");
    try {
      // Same per-key PUT the row editor used before — just batched over every dirty key.
      const updates = dirtyKeys
        .map((key) => ({ key, value: draft[key] }))
        .filter((u): u is { key: ConfigKey; value: ConfigValue } => u.value !== undefined);
      await Promise.all(updates.map((u) => adminApi.putConfig(token, u.key, u.value)));
      load();
    } catch {
      setState("error");
    }
  };

  if (loadError) return <div className="max-w-[860px] text-rejected">{t("admin.loadError")}</div>;
  if (!items) return <Spinner />;

  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));

  return (
    <div className="max-w-[860px]">
      {SECTIONS.map((section) => {
        const fields = FIELDS.filter((f) => f.section === section.id && byKey[f.key]);
        if (fields.length === 0) return null;
        return (
          <SectionCard
            key={section.id}
            title={t(section.titleKey)}
            description={t(section.descKey)}
          >
            {fields.map((field) => {
              const item = byKey[field.key];
              if (!item) return null;
              return (
                <ConfigRow
                  key={field.key}
                  field={field}
                  value={draft[field.key] ?? item.value}
                  onChange={(v) => setValue(field.key, v)}
                />
              );
            })}
          </SectionCard>
        );
      })}

      {dirtyKeys.length > 0 ? (
        <div
          className="sticky bottom-0 -mx-8 -mb-16 flex items-center gap-3.5 px-8 py-4"
          style={{
            background: "linear-gradient(to top, #e9edeb 60%, rgba(233,237,235,0))",
          }}
        >
          <div className="text-[13px] text-muted">
            {state === "error" ? t("admin.save.error") : t("admin.save.unsaved")}
          </div>
          <div className="ms-auto flex gap-2.5">
            <button
              type="button"
              onClick={discard}
              disabled={state === "saving"}
              className="rounded-[13px] border border-[#e0e6e3] bg-surface px-5 py-3 text-sm font-bold text-ink transition hover:bg-base disabled:opacity-50"
            >
              {t("admin.save.discard")}
            </button>
            <div className="w-[150px]">
              <Button onClick={save} loading={state === "saving"}>
                {t("admin.save.save")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-4 rounded-card border border-line bg-surface px-[26px]">
      <div className="pb-1.5 pt-5">
        <div className="text-base font-bold text-ink">{title}</div>
        <div className="mt-0.5 text-[13px] text-muted">{description}</div>
      </div>
      {children}
    </section>
  );
}

function ConfigRow({
  field,
  value,
  onChange,
}: {
  field: FieldMeta;
  value: ConfigValue;
  onChange: (value: ConfigValue) => void;
}) {
  const { t } = useTranslation();
  const id = field.key.replace(/\./g, "_");
  const title = t(`admin.keys.${id}.title`);
  const desc = t(`admin.keys.${id}.desc`);

  return (
    <div className="flex flex-col gap-3 border-t border-[#eef2f0] py-5 sm:flex-row sm:items-center sm:gap-5">
      <div className="flex-1">
        <div className="text-sm font-semibold text-ink">{title}</div>
        <div className="mt-0.5 text-[12.5px] text-muted">{desc}</div>
      </div>
      <div className="sm:w-[300px] sm:flex-shrink-0">
        <FieldControl field={field} title={title} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function FieldControl({
  field,
  title,
  value,
  onChange,
}: {
  field: FieldMeta;
  title: string;
  value: ConfigValue;
  onChange: (value: ConfigValue) => void;
}) {
  const { t } = useTranslation();

  if (field.control === "switch") {
    return (
      <div className="flex sm:justify-end">
        <Switch checked={Boolean(value)} onChange={onChange} label={title} />
      </div>
    );
  }

  if (field.control === "fxProvider") {
    return (
      <div className="flex sm:justify-end">
        <Segmented
          value={String(value)}
          onChange={onChange}
          options={[
            { value: "ecb", label: t("admin.fxProvider.ecb") },
            { value: "boi", label: t("admin.fxProvider.boi") },
          ]}
        />
      </div>
    );
  }

  if (field.control === "percent") {
    return (
      <RangeSlider
        value={Number(value)}
        min={field.min ?? 0}
        max={field.max ?? 10000}
        step={field.step ?? 50}
        onChange={onChange}
        label={title}
        format={(bps) => `${trimNum(bps / 100)}%`}
      />
    );
  }

  // number
  return <NumberField field={field} title={title} value={Number(value)} onChange={onChange} />;
}

function NumberField({
  field,
  title,
  value,
  onChange,
}: {
  field: FieldMeta;
  title: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const clamp = (n: number) =>
    Math.min(field.max ?? Number.MAX_SAFE_INTEGER, Math.max(field.min ?? 0, n));
  return (
    <div className="flex items-center gap-2.5 rounded-input border border-[#e0e6e3] bg-base px-3.5 py-2.5 sm:ms-auto sm:w-[160px]">
      <input
        type="number"
        aria-label={title}
        min={field.min}
        max={field.max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className="tabular w-full border-none bg-transparent text-base font-bold text-ink outline-none"
      />
      {field.unit ? (
        <span className="flex-shrink-0 text-[13px] font-semibold text-muted">
          {t(`admin.units.${field.unit}`)}
        </span>
      ) : null}
    </div>
  );
}

// Trim trailing zeros from a percentage label (5000 bps → "50%", 250 bps → "2.5%").
function trimNum(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "");
}
