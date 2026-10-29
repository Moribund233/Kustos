/**
 * 时间格式化。
 *
 * 原型里活动时间、评论时间用的是相对时间（“3 分钟前”），审计与提交记录用绝对时间。
 * 统一走 dayjs，避免各处手写 `new Date().getTime()` 造成时区漂移。
 */
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import utc from "dayjs/plugin/utc";
import "dayjs/locale/zh-cn";
import "dayjs/locale/en";

import i18n from "@/lib/i18n";

dayjs.extend(relativeTime);
dayjs.extend(utc);

// 相对时间（「3 分钟前」）跟随界面语言；语言在启动时已 init，这里同步一次并持续跟随
dayjs.locale(i18n.resolvedLanguage === "en" ? "en" : "zh-cn");
i18n.on("languageChanged", (lng) => dayjs.locale(lng === "en" ? "en" : "zh-cn"));

/** 相对时间，如「3 分钟前」「昨天」。 */
export function formatRelative(value: string | number | Date | null | undefined): string {
  if (!value) return "";
  return dayjs(value).fromNow();
}

/** 绝对时间，精确到分钟。 */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (!value) return "";
  return dayjs(value).format("YYYY-MM-DD HH:mm");
}

/** 仅日期。 */
export function formatDate(value: string | number | Date | null | undefined): string {
  if (!value) return "";
  return dayjs(value).format("YYYY-MM-DD");
}

/** ISO 字符串，用于 `<time datetime>`。 */
export function toIsoString(value: string | number | Date | null | undefined): string {
  if (!value) return "";
  return dayjs(value).toISOString();
}
