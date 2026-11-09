/**
 * 相对时间。
 *
 * 列表的信息密度优先，绝对时间在这一层是噪声。文案走翻译键：
 * "3 分钟前" 与 "3m ago" 的长度差异会直接影响行内布局，
 * 因此英文版刻意用更短的形式。
 *
 * Args:
 *
 *	iso: ISO 时间串，可为空
 *	t:   翻译函数（由调用方的 useTranslation 提供）
 *	localeTag: 用于超过 30 天时的日期格式
 */
export function relativeTime(
  iso: string | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
  localeTag = "zh-CN",
): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return t("relativeTime.justNow");
  if (diff < hour) return t("relativeTime.minutesAgo", { count: Math.floor(diff / minute) });
  if (diff < day) return t("relativeTime.hoursAgo", { count: Math.floor(diff / hour) });
  if (diff < 30 * day) return t("relativeTime.daysAgo", { count: Math.floor(diff / day) });
  return new Date(iso).toLocaleDateString(localeTag);
}
