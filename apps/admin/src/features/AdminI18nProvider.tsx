import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { adminI18n } from "../admin-i18n";

/**
 * The admin console's i18n boundary: every admin page renders inside it. Provides the console's
 * i18next instance (admin-i18n.ts — its own persisted language choice under `wanthat.adminLang`).
 * Document direction is applied by admin-i18n.ts itself: since the console moved to its own
 * origin this app is the document's only owner, so the old claim/release dance against the
 * member instance is gone.
 */
export function AdminI18nProvider({ children }: { children: ReactNode }) {
  return <I18nextProvider i18n={adminI18n}>{children}</I18nextProvider>;
}
