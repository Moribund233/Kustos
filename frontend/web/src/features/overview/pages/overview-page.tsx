import { useTranslation } from "react-i18next";

import { PlaceholderPage } from "@/pages/placeholder-page";

/** 工作台首页（Watch）。 */
export function OverviewPage() {
  const { t } = useTranslation();
  return <PlaceholderPage title={t("overview.title")} hint={t("overview.todo")} />;
}
