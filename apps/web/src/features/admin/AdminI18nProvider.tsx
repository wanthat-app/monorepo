import { type ReactNode, useEffect } from "react";
import { I18nextProvider } from "react-i18next";
import { adminI18n } from "../../admin-i18n";
import i18n from "../../i18n";
import { claimDocumentLanguage } from "../../lib/document-language";

/**
 * The admin console's i18n boundary: every admin page renders inside it. Provides the
 * console's own i18next instance (admin-i18n.ts — separate language + storage from the member
 * app) and owns the document direction while mounted, handing it back to the member instance
 * on unmount. Member-side language changes (e.g. the profile-locale sync) therefore never
 * reach the admin panel, and the admin toggle never leaks into the member app.
 */
export function AdminI18nProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    claimDocumentLanguage("admin", adminI18n.language);
    return () => claimDocumentLanguage("app", i18n.language);
  }, []);
  return <I18nextProvider i18n={adminI18n}>{children}</I18nextProvider>;
}
