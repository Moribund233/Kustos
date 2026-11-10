import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { WindowService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";

/**
 * 把托盘菜单的文案同步成当前界面语言。
 *
 * 为什么要同步：托盘在应用启动时就已经可用，Go 侧先用一套默认中文把菜单建好
 * （那几百毫秒里用户的界面可能还在恢复会话）。界面语言确定后必须覆盖一次，
 * 否则英文用户会在托盘里看到中文。
 *
 * 只在语言变化时下发：每次渲染都调一次会不停写菜单标签，而托盘菜单正在被
 * 用户展开时改标签会让它闪。
 */
export function useTrayLabels(): void {
  const { t, i18n } = useTranslation();

  useEffect(() => {
    void WindowService.SetTrayLabels({
      showMain: t("tray.showMain"),
      review: t("tray.review"),
      quit: t("tray.quit"),
      tooltip: t("tray.tooltip"),
    });
    // 语言是唯一的相关输入：文案表随语言整体变化。
  }, [t, i18n.resolvedLanguage]);
}

/**
 * 打开指定种类的窗口。
 *
 * Args:
 *
 *	kind: `main` 或 `review`
 */
export function openWindow(kind: "main" | "review"): void {
  void WindowService.OpenWindow(kind);
}

/**
 * 在评审窗里打开某个 PR。
 *
 * 已存在的评审窗会被换成这个 PR 并唤到前面：用户点了另一个 PR 的"在窗口中
 * 打开"，期望是那个窗口换过去，而不是什么都不发生。
 *
 * Args:
 *
 *	prNumber: 仓库内的 PR 编号
 */
export function openReviewWindow(prNumber: number): void {
  void WindowService.OpenWindowWith("review", String(prNumber));
}
