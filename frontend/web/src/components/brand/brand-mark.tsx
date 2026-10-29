import { cn } from "@/lib/utils";

/**
 * Kustos 品牌标记（提灯）。
 *
 * 图形是原型 `docs/prototype/assets/brand/kustos-mark.svg` 的**原样**资产，
 * 复制到 `public/brand/` 供运行时按尺寸取用：不重绘 path、不改渐变，
 * 品牌只在一处维护。暗底用 `kustos-mark`（骨白描边），浅底用 `kustos-mark-ink`。
 */

export interface BrandMarkProps {
  /** 边长（px）。原型侧栏 31、登录页 42。 */
  size?: number;
  /** 浅底场景用深色描边版本。 */
  ink?: boolean;
  className?: string;
  /** 有意义的品牌图需要给 alt；装饰性留空。 */
  decorative?: boolean;
}

export function BrandMark({ size = 31, ink = false, className, decorative = true }: BrandMarkProps) {
  return (
    <img
      src={ink ? "/brand/kustos-mark-ink.svg" : "/brand/kustos-mark.svg"}
      width={size}
      height={size}
      alt={decorative ? "" : "Kustos"}
      aria-hidden={decorative || undefined}
      className={cn("shrink-0 select-none", className)}
      draggable={false}
    />
  );
}
