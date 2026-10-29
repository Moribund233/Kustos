/**
 * i18next 初始化。
 *
 * 语言优先级：用户显式选择（localStorage）> 浏览器语言 > 默认中文。
 * 归一化只保留 zh/en，与后端 `app/core/i18n.py` 的 `SUPPORTED_LOCALES` 对齐。
 */
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import en from "./locales/en";
import zh from "./locales/zh";
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "./locales";

export const LOCALE_STORAGE_KEY = "kustos.locale";

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
    // 非标准标记（zh-CN / en-US）在这里收敛，避免资源查找失败
    load: "currentOnly",
    interpolation: {
      // React 已负责转义，交给 i18next 会产生重复转义
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
 * @param locale 目标语言
 */
export function setLocale(locale: Locale): void {
  void i18n.changeLanguage(locale);
}

/**
 * 当前语言的 `Accept-Language` 头值。
 *
 * 后端据此翻译错误消息（`detail`），前端要保证请求头与界面语言一致，
 * 否则用户会看到中文界面配英文报错，或反之。
 */
export function currentAcceptLanguage(): string {
  return currentLocale() === "en" ? "en-US,en;q=0.9" : "zh-CN,zh;q=0.9";
}

export default i18n;
