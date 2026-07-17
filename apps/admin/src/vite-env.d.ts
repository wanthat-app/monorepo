/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** admin-api HTTP API base URL (per-environment, injected at build in local dev only). */
  readonly VITE_ADMIN_API_URL?: string;
  /** Employee pool Managed Login base URL for the console OAuth flow. */
  readonly VITE_ADMIN_MANAGED_LOGIN_URL?: string;
  /** Employee pool admin SPA app client id (public). */
  readonly VITE_ADMIN_POOL_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
