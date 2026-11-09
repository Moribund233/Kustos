/**
 * 支持的语言。
 *
 * 与后端 `app/core/i18n.py` 的 `SUPPORTED_LOCALES` 保持一致：后端只认 zh/en，
 * 前端多传一种语言，后端也会按默认语言回落，界面与报错会语言不一致。
 */
export const SUPPORTED_LOCALES = ["zh", "en"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** 默认语言与后端保持一致（后端 DEFAULT_LOCALE = "zh"）。 */
export const DEFAULT_LOCALE: Locale = "zh";

export const LOCALE_LABELS: Record<Locale, string> = {
  zh: "简体中文",
  en: "English",
};

/**
 * 把任意语言标记归一化到受支持的语言。
 *
 * `zh-CN`、`zh_Hans`、`en-US` 这类带区域的标记取基础子标签；
 * 无法识别时回落到默认语言。
 */
export function normalizeLocale(tag: string | undefined | null): Locale {
  if (!tag) return DEFAULT_LOCALE;
  const base = tag.toLowerCase().split(/[-_]/)[0] ?? "";
  return (SUPPORTED_LOCALES as readonly string[]).includes(base)
    ? (base as Locale)
    : DEFAULT_LOCALE;
}
