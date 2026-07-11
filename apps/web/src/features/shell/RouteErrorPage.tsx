import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, useRouteError } from "react-router-dom";
import { Screen } from "../../ui/components";

/**
 * Route-level error boundary — replaces react-router's developer error page ("Unexpected
 * Application Error!") when any route element throws during render. Members get friendly
 * bilingual copy with a reload and a way home; the underlying error still lands in the
 * console for diagnosis.
 */
export function RouteErrorPage() {
  const { t } = useTranslation();
  const error = useRouteError();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Screen>
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="font-display text-[72px] font-bold leading-none tracking-[-0.03em] text-accent">
          {t("error.oops")}
        </div>
        <h1 className="m-0 font-display text-2xl font-bold text-ink">{t("error.title")}</h1>
        <p className="m-0 text-sm text-muted">{t("error.message")}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 inline-flex h-12 items-center justify-center rounded-button bg-accent px-6 font-display font-semibold text-white transition hover:bg-accent/90"
        >
          {t("error.retry")}
        </button>
        <Link to="/" reloadDocument className="text-sm font-bold text-accent">
          {t("error.home")}
        </Link>
      </div>
    </Screen>
  );
}
