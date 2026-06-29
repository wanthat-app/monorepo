import type { ConfigItem, ConfigValue } from "@wanthat/contracts";
import { useCallback, useEffect, useState } from "react";
import { adminApi, type StatsOverview } from "../../lib/admin-api";
import { useSession } from "../../lib/session";
import { Button, Card, Spinner } from "../../ui/components";

/**
 * Admin console (Wanthat Admin) — desktop, English/LTR. Config editor (full CRUD over the typed keys)
 * + a stats panel whose users count is live (Aurora COUNT) and whose other metrics are placeholders.
 * Gated on the `admin` group client-side; admin-api re-enforces it server-side.
 */
export function AdminPage() {
  const { isAdmin, loading, accessToken } = useSession();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div dir="ltr" className="flex min-h-screen items-center justify-center text-muted">
        Not authorised.
      </div>
    );
  }

  return (
    <div dir="ltr" className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <h1 className="text-3xl">Wanthat Admin</h1>
      <StatsPanel token={accessToken()} />
      <ConfigPanel token={accessToken()} />
    </div>
  );
}

function StatsPanel({ token }: { token: string | null }) {
  const [stats, setStats] = useState<StatsOverview | null>(null);
  useEffect(() => {
    if (token)
      adminApi
        .statsOverview(token)
        .then(setStats)
        .catch(() => setStats(null));
  }, [token]);

  return (
    <Card>
      <h2 className="mb-4 text-xl">Overview</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Users" value={stats ? String(stats.usersCount) : "…"} live />
        <Stat label="Pending approvals" value="—" />
        <Stat label="Cashback (30d)" value="—" />
        <Stat label="Conversions (30d)" value="—" />
      </div>
    </Card>
  );
}

function Stat({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="rounded-input bg-base p-4">
      <div className="text-sm text-muted">
        {label}
        {live ? <span className="ms-1 text-accent">●</span> : null}
      </div>
      <div className="tabular mt-1 text-2xl font-display font-semibold">{value}</div>
    </div>
  );
}

function ConfigPanel({ token }: { token: string | null }) {
  const [items, setItems] = useState<ConfigItem[] | null>(null);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(() => {
    if (token)
      adminApi
        .listConfig(token)
        .then((r) => setItems(r.items))
        .catch(() => setError("Failed to load config"));
  }, [token]);
  useEffect(load, [load]);

  return (
    <Card>
      <h2 className="mb-4 text-xl">Configuration</h2>
      {error ? <p className="mb-3 text-rejected">{error}</p> : null}
      {!items ? (
        <Spinner />
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {items.map((item) => (
            <ConfigRow key={item.key} item={item} token={token} onSaved={load} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ConfigRow({
  item,
  token,
  onSaved,
}: {
  item: ConfigItem;
  token: string | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<string>(String(item.value));
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");

  const coerce = (raw: string): ConfigValue => {
    if (typeof item.value === "number") return Number(raw);
    if (typeof item.value === "boolean") return raw === "true";
    return raw;
  };

  const onSave = async () => {
    if (!token) return;
    setState("saving");
    try {
      await adminApi.putConfig(token, item.key, coerce(draft));
      setState("idle");
      onSaved();
    } catch {
      // A 400 means the value failed its schema; the row border turns red.
      setState("error");
    }
  };

  return (
    <div className="flex items-center gap-4 py-3">
      <code className="flex-1 text-sm">{item.key}</code>
      {typeof item.value === "boolean" ? (
        <select
          className="h-10 rounded-input border border-line bg-surface px-3"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          className={`h-10 w-40 rounded-input border bg-surface px-3 text-end tabular ${
            state === "error" ? "border-rejected" : "border-line"
          }`}
          inputMode={typeof item.value === "number" ? "numeric" : "text"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      <div className="w-24">
        <Button
          onClick={onSave}
          loading={state === "saving"}
          disabled={draft === String(item.value)}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
