/**
 * Runtime config for the landing app — ONLY the Cognito coordinates its auth module needs
 * (the returning-member passkey login talks to Cognito directly, ADR-0006). Same mechanism as
 * the member app: the site bucket's `/config.json` (same-origin, written by the EdgeStack) is
 * fetched once before render; local dev falls back to build-time `VITE_*` vars. Extra fields in
 * config.json (apiUrl, adminOrigin — member-app concerns) are simply ignored here.
 */
export interface RuntimeConfig {
  /** Region of the Cognito customer pool — cognito-idp.<region>.amazonaws.com (ADR-0006). */
  cognitoRegion: string;
  /** Customer pool SPA app client id — the public client for InitiateAuth (ADR-0006). */
  userPoolClientId: string;
}

const fromEnv = (): RuntimeConfig => ({
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
 * fail: on a 404 (local dev), a non-JSON body, or a network error, we keep the `.env.local` values.
 */
export async function initConfig(): Promise<void> {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as Partial<RuntimeConfig>;
    current = {
      cognitoRegion: data.cognitoRegion ?? current.cognitoRegion,
      userPoolClientId: data.userPoolClientId ?? current.userPoolClientId,
    };
  } catch {
    // keep the build-time fallback
  }
}
