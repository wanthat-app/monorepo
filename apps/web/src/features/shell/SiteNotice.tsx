import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { configApi } from "../../lib/api";

/**
 * Admin-set site-wide notice (runtime config `site.noticeEn` / `site.noticeHe`, public keys):
 * when either text is non-empty, every member page carries a warning bar with it (e.g. "test
 * environment", maintenance heads-up). Language follows the member locale; either text falls
 * back to the other when only one is set. Fetch failure or empty values render nothing — the
 * banner can never block the app.
 */
export function SiteNotice() {
  const { i18n } = useTranslation();
  const notice = useQuery({
    queryKey: ["public-config", "site-notice"],
    queryFn: () => configApi.getPublic(["site.noticeEn", "site.noticeHe"]),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const values = notice.data?.values;
  if (!values) return null;
  const en = typeof values["site.noticeEn"] === "string" ? values["site.noticeEn"].trim() : "";
  const he = typeof values["site.noticeHe"] === "string" ? values["site.noticeHe"].trim() : "";
  const preferHe = i18n.language.startsWith("he");
  const text = preferHe ? he || en : en || he;
  if (!text) return null;

  return (
    <div
      role="status"
      dir={text === he && he !== "" ? "rtl" : "ltr"}
      className="border-b border-pending/25 bg-pending-soft px-4 py-2 text-center text-[13px] font-semibold leading-snug text-pending"
    >
      {text}
    </div>
  );
}
