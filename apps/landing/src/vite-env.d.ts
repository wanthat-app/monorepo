/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Region of the Cognito customer pool (public). */
  readonly VITE_COGNITO_REGION?: string;
  /** Cognito SPA app client id (public). */
  readonly VITE_USER_POOL_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
