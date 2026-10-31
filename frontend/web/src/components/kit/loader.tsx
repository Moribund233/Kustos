import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

/**
 * 页面加载态：三枚状态灯依次呼吸。
 *
 * 取意「夜巡提灯」——不是通用的旋转菊花，而是产品里既有的状态灯词汇
 * （见 `Lamp`、`StatusPill`）的放大版：首尾两盏偏冷、中间一盏是骨白，
 * 逐个呼吸代表巡夜仍在进行。放在内容区中央，等宽于页面主栏。
 *
 * `role="status"` 让读屏在加载结束时播报；文案走 i18n。
 */
export function PageLoader({ label, className }: { label?: string; className?: string }) {
  const { t } = useTranslation();

  return (
    <div
      role="status"
      className={cn("grid min-h-[52vh] w-full place-items-center px-6 py-10", className)}
    >
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-end gap-[7px]" aria-hidden="true">
          <span className="animate-lamp-breathe size-1.5 rounded-full bg-amber shadow-[0_0_10px_rgba(242,174,91,0.55)]" />
          <span
            className="animate-lamp-breathe size-[7px] rounded-full bg-bone/85 shadow-[0_0_10px_rgba(240,231,216,0.4)]"
            style={{ animationDelay: "0.18s" }}
          />
          <span
            className="animate-lamp-breathe size-1.5 rounded-full bg-sky shadow-[0_0_9px_rgba(131,169,196,0.5)]"
            style={{ animationDelay: "0.36s" }}
          />
        </div>
        <p className="text-faint font-mono text-2xs tracking-[0.22em] uppercase">
          {label ?? t("common.loading")}
        </p>
      </div>
    </div>
  );
}
