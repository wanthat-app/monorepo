/**
 * Runtime SPA config — the backend URLs + Cognito client ids the app needs at load.
 *
 * On the deployed site the EdgeStack writes `/config.json` into the S3 bucket (all-public values:
 * client ids, endpoint hosts), and {@link initConfig} fetches it once before render. This decouples
 * the built bundle from per-environment values — the SPA is bundled into CloudFront *before* the
 * backend stacks' outputs exist, so build-time `VITE_*` can't carry them on the hosted site.
 *
 * In local dev (`pnpm --filter @wanthat/web dev`) there is no `/config.json`, so we fall back to the
 * build-time `VITE_*` vars from `.env.local`. Any field present in `config.json` overrides the
 * fallback, so a developer can still point localhost at a deployed environment via `.env.local`.
 */
export interface RuntimeConfig {
  /** app-api base URL (links + wallet). */
  apiUrl: string;
  /**
   * Region of the Cognito customer pool — the SPA calls `cognito-idp.<region>.amazonaws.com`
   * directly for every auth ceremony (ADR-0006). Defaults to il-central-1 (the only deployed
   * region); config.json may override if that ever changes.
   */
  cognitoRegion: string;
  /** Customer pool SPA app client id — the public client for SignUp/InitiateAuth (ADR-0006). */
  userPoolClientId: string;
  /**
   * The admin console's origin (`https://admin.{domain}`) — the console is its OWN app on its
   * own origin (apps/admin), so employee tokens are storage-isolated from this member app. Only
   * the /admin* redirect stub reads it; empty means "no admin origin configured" (local dev).
   */
}

const fromEnv = (): RuntimeConfig => ({
  apiUrl: import.meta.env.VITE_API_URL ?? "",
  cognitoRegion: import.meta.env.VITE_COGNITO_REGION ?? "il-central-1",
  userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID ?? "",
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
