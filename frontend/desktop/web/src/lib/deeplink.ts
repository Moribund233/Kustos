/**
 * 深链落屏。
 *
 * 系统别处发来一条 `kustos://...` 时，Go 侧解析出目标分区并广播
 * `deeplink:navigate`；这里把它翻成界面分区。
 *
 * 两件事都要做，缺一个就有窗口收不到：
 *
 *  1. 订阅事件——应用已经在运行时收到深链走这条；
 *  2. 启动时主动问一次 `PendingSurface`——深链可能在窗口刚创建、这段代码
 *     还没注册监听时到达，那时广播没有任何接收者。
 *
 * 只认白名单内的分区：Go 侧已经校验过一遍，这边再收一次是防"绑定层与
 * 前端版本不一致"。未知值直接丢弃，不猜一个分区打开。
 */
import { useEffect } from "react";
import { Events } from "@wailsio/runtime";

import { DeeplinkNavigate } from "@/bindings/events";
import { SystemService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";

/** 深链可以落到的分区，与 `shell.tsx` 的 Surface 标识逐字一致。 */
const DEEPLINK_SURFACES = ["inbox", "working-copy", "code", "pulls", "issues"] as const;

export type DeeplinkSurface = (typeof DEEPLINK_SURFACES)[number];

/**
 * 判断一个字符串是不是可落的分区。
 *
 * Args:
 *
 *	value: 事件或 Go 侧返回的分区名
 *
 * Returns:
 *
 *	是已知分区时返回它本身，否则为 null。
 */
export function asDeeplinkSurface(value: string | null | undefined): DeeplinkSurface | null {
  if (!value) return null;
  const found = DEEPLINK_SURFACES.find((surface) => surface === value);
  return found ?? null;
}

/**
 * 订阅深链导航。
 *
 * Args:
 *
 *	onNavigate: 收到可识别的分区时被调用；同一分区重复到达不会去重，
 *	            因为"再点一次同一条链接"是一个真实意图。
 *	enabled:    会话就绪后才订阅——未登录时切分区没有意义。
 */
export function useDeeplinkNavigation(onNavigate: (surface: DeeplinkSurface) => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    // 启动兜底：读走启动期攒下的目标。读一次就清空，之后靠事件。
    let cancelled = false;
    void (async () => {
      try {
        const pending = await SystemService.PendingSurface();
        if (cancelled) return;
        const surface = asDeeplinkSurface(pending);
        if (surface !== null) onNavigate(surface);
      } catch {
        // 拿不到启动目标不是错误：窗口可能不是由深链打开的。
      }
    })();

    const off = Events.On(DeeplinkNavigate, (event) => {
      const surface = asDeeplinkSurface(event.data as string);
      if (surface !== null) onNavigate(surface);
    });

    return () => {
      cancelled = true;
      off();
    };
  }, [enabled, onNavigate]);
}
