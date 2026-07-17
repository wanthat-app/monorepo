/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** app-api HTTP API base URL (per-environment, injected at build). */
  readonly VITE_API_URL?: string;
  /** Cognito Managed Login base URL for the discoverable passkey flow. */
  readonly VITE_MANAGED_LOGIN_URL?: string;
  /** Cognito SPA app client id (public). */
  readonly VITE_USER_POOL_CLIENT_ID?: string;
  /** The admin console's origin (its own app on admin.{domain}) — read by the /admin* redirect stub. */
  readonly VITE_ADMIN_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
