import { useEffect, useState } from "react";

import { PageLoader } from "@/components/kit/loader";

/** 低于该阈值的等待不显示加载态。 */
const SHOW_DELAY_MS = 120;

/**
 * 懒加载页面的占位。
 *
 * 路由切分后的 chunk 多数在几十毫秒内到齐，立刻渲染加载态会让用户看到
 * 「一闪而过的灯」而不是「正在加载」。延迟 120ms 再显示：更短的等待保持
 * 空白，视觉上等同于直接切换；更长的等待才需要告知用户。
 */
export function PageFallback() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return visible ? <PageLoader /> : null;
}
