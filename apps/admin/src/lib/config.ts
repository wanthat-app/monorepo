/**
 * Runtime SPA config — the backend URL + employee-pool client the admin console needs at load.
 *
 * Same pattern as the member app: on the deployed site the EdgeStack writes `/config.json` into
 * the admin S3 bucket (all-public values: client id, endpoint hosts) and {@link initConfig}
 * fetches it once before render — the bundle is built before the backend stacks' outputs exist,
 * so build-time `VITE_*` can't carry them on the hosted site.
 *
 * In local dev (`pnpm --filter @wanthat/admin-app dev`, port 5174) there is no `/config.json`, so
 * we fall back to the build-time `VITE_*` vars from `.env.local`. Any field present in
 * `config.json` overrides the fallback, so a developer can still point localhost at a deployed
 * environment via `.env.local`.
 */
export interface RuntimeConfig {
  /** admin-api base URL (the console's whole backend surface). */
  adminApiUrl: string;
  /** Employee pool Managed Login (hosted UI) base URL — the console's OAuth redirect. */
  adminManagedLoginUrl: string;
  /** Employee pool admin SPA app client id (OAuth client_id). */
  adminPoolClientId: string;
}

const fromEnv = (): RuntimeConfig => ({
  adminApiUrl: import.meta.env.VITE_ADMIN_API_URL ?? "",
  adminManagedLoginUrl: import.meta.env.VITE_ADMIN_MANAGED_LOGIN_URL ?? "",
  adminPoolClientId: import.meta.env.VITE_ADMIN_POOL_CLIENT_ID ?? "",
});

let current: RuntimeConfig = fromEnv();

/** The effective runtime config. Read this at call time (not module load), so it reflects initConfig. */
export function getConfig(): RuntimeConfig {
  return current;
}

/**
 * Load `/config.json` and merge it over the build-time fallback. Call once before rendering. Safe to
 * fail: on a 404 (local dev), a non-JSON body (SPA index.html fallback), or a network error, we keep
 * the `.env.local` values so local development is unaffected.
 */
export async function initConfig(): Promise<void> {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as Partial<RuntimeConfig>;
    current = { ...current, ...data };
  } catch {
    // keep the build-time fallback
  }
}
