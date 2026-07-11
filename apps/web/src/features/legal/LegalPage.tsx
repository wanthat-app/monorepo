import { useTranslation } from "react-i18next";
import { Screen } from "../../ui";
import { AppHeader } from "../shell/AppHeader";

/**
 * Sample legal pages (/terms, /privacy) — placeholder copy until counsel-approved text
 * lands, flagged by a visible draft notice. Content lives in the i18n dictionary as
 * {h, p} sections so both languages stay structurally identical.
 */
export function LegalPage({ kind }: { kind: "terms" | "privacy" }) {
  const { t } = useTranslation();
  const sections = t(`legal.${kind}.sections`, { returnObjects: true }) as {
    h: string;
    p: string;
  }[];

  return (
    <Screen>
      <div className="flex flex-col py-4">
        <div className="mb-6">
          <AppHeader />
        </div>
        <h1 className="mb-2 text-[27px] font-bold tracking-[-0.03em]">
          {t(`legal.${kind}.title`)}
        </h1>
        <p className="mb-3 text-[13px] text-muted">{t("legal.updated")}</p>
        <p className="mb-6 self-start rounded-full bg-pending-soft px-3 py-1 text-[12px] font-semibold text-pending">
          {t("legal.sampleNotice")}
        </p>
        <div className="flex flex-col gap-5">
          {sections.map((s) => (
            <section key={s.h}>
              <h2 className="mb-1.5 text-[17px] font-bold">{s.h}</h2>
              <p className="text-[14.5px] leading-relaxed text-secondary">{s.p}</p>
            </section>
          ))}
        </div>
      </div>
    </Screen>
  );
}
