/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** app-api HTTP API base URL (per-environment, injected at build). */
  readonly VITE_API_URL?: string;
  /** admin-api HTTP API base URL (separate from app-api). */
  readonly VITE_ADMIN_API_URL?: string;
  /** Cognito Managed Login base URL for the discoverable passkey flow. */
  readonly VITE_MANAGED_LOGIN_URL?: string;
  /** Cognito SPA app client id (public). */
  readonly VITE_USER_POOL_CLIENT_ID?: string;
  /** Employee pool Managed Login base URL for the admin console OAuth flow. */
  readonly VITE_ADMIN_MANAGED_LOGIN_URL?: string;
  /** Employee pool admin SPA app client id (public). */
  readonly VITE_ADMIN_POOL_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
