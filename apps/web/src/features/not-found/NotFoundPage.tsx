import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Screen } from "../../ui/components";

/** Catch-all 404 — replaces react-router's developer error page on unknown URLs. */
export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <Screen>
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="font-display text-[72px] font-bold leading-none tracking-[-0.03em] text-accent">
          404
        </div>
        <h1 className="m-0 font-display text-2xl font-bold text-ink">{t("notFound.title")}</h1>
        <p className="m-0 text-sm text-muted">{t("notFound.message")}</p>
        <Link
          to="/"
          className="mt-4 inline-flex h-12 items-center justify-center rounded-button bg-accent px-6 font-display font-semibold text-white transition hover:bg-accent/90"
        >
          {t("notFound.home")}
        </Link>
      </div>
    </Screen>
  );
}
