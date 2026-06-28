import { useTranslation } from "react-i18next";

export function App() {
  const { t } = useTranslation();
  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold">{t("app.title")}</h1>
    </main>
  );
}
