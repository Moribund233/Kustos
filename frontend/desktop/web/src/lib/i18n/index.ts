/**
 * 桌面端 i18n 入口。
 *
 * 与 Web 端用同一套技术栈（i18next + react-i18next + 语言检测），
 * 但**资源文件独立**：桌面端的界面词汇与 Web 不同（三栏、工作副本、
 * 本地 git、状态条），共用一份 locale 会迫使两边取交集。
 *
 * 语言优先级：用户显式选择（localStorage）> 系统语言 > 默认中文。
 * 归一化只保留 zh/en，与后端 `app/core/i18n.py` 的 `SUPPORTED_LOCALES` 对齐：
 * 前端多传一种语言时后端会按默认语言回落，界面与报错就会语言不一致。
 */
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.ts";
import zh from "./locales/zh.ts";
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "./locales.ts";

export const LOCALE_STORAGE_KEY = "kustos.desktop.locale";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      zh: { translation: zh },
      en: { translation: en },
    },
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: ["zh", "en"],
    // 非标准标记（zh-CN / en-US）在这里收敛，避免资源查找失败。
    load: "currentOnly",
    interpolation: {
      // React 已负责转义。
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
      caches: ["localStorage"],
    },
  });

/** 读取当前语言（已归一化）。 */
export function currentLocale(): Locale {
  return normalizeLocale(i18n.resolvedLanguage ?? i18n.language);
}

/**
 * 切换语言。
 *
 * Args:
 *
 *	locale: 目标语言
 */
export function setLocale(locale: Locale): void {
  void i18n.changeLanguage(locale);
}

/** 生成 `Accept-Language` 头，让后端按同一语言翻译错误消息。 */
export function acceptLanguageHeader(locale: Locale): string {
  return locale === "en" ? "en-US,en;q=0.9" : "zh-CN,zh;q=0.9";
}

export { i18n };
export { DEFAULT_LOCALE, SUPPORTED_LOCALES, LOCALE_LABELS, normalizeLocale } from "./locales.ts";
export type { Locale } from "./locales.ts";

