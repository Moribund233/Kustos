import type { CodeLayout } from "@/bindings/github.com/kustos/kustos-desktop/internal/services/models";

/**
 * Code 面布局的纯逻辑：把内存里的标签页/展开目录翻译成可持久化的形状，
 * 以及反过来把存下来的布局套回界面。
 *
 * 抽出来是因为这里有两个容易出错的判断——**布局属于哪个仓库**、
 * **什么情况下该放弃恢复**——它们不该埋在 effect 里靠人工推断。
 *
 * 布局只存一份（键 `code.layout`），因此同一时刻只对一个工作副本有效：
 * 路径相对各自仓库根，把 A 仓库的标签套到 B 仓库上会打开一堆不存在或不
 * 相干的文件。
 */

/** 标签页在界面上的最小形状。 */
export interface LayoutTab {
  path: string;
  name: string;
}

/** 恢复出来的布局。 */
export interface RestoredLayout {
  tabs: LayoutTab[];
  activePath: string | null;
  expanded: Set<string>;
}

/** 路径的最后一段，用作标签名。 */
export function tabName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 这份布局是否属于给定的工作副本。
 *
 * 没有仓库 id 的布局（旧版本或损坏）一律视为不适用：套上去是猜的。
 */
export function layoutAppliesTo(layout: CodeLayout | null | undefined, workingCopyId: string | null): boolean {
  if (!layout || !workingCopyId) return false;
  return layout.workingCopyId === workingCopyId;
}

/**
 * 把存的布局套回界面状态。
 *
 * Returns:
 *
 * 恢复后的标签页、当前文件与展开目录；布局不适用或没有标签时返回 null，
 * 表示"保持空白"，调用方据此跳过这次恢复。
 *
 * 注意这里不再做去重与路径校验：Go 侧 `codestate.Normalize` 已经收敛过，
 * 重复清洗只会让两处规则各自漂移。
 */
export function restoreLayout(
  layout: CodeLayout | null | undefined,
  workingCopyId: string | null,
): RestoredLayout | null {
  if (!layoutAppliesTo(layout, workingCopyId)) return null;
  const paths = layout?.tabs ?? [];
  if (paths.length === 0) return null;

  const tabs = paths.map((path) => ({ path, name: tabName(path) }));
  const active = layout?.activePath ?? "";
  // 当前文件不在标签条里时退到第一个：界面不该出现"活动标签不存在"的状态。
  const activePath = tabs.some((t) => t.path === active) ? active : tabs[0].path;

  return {
    tabs,
    activePath,
    expanded: new Set(layout?.expanded ?? []),
  };
}

/**
 * 把界面状态翻译成待保存的布局。
 *
 * 没有工作副本时返回 null——路径相对仓库根，没有仓库就没有可存的内容。
 */
export function buildLayout(
  workingCopyId: string | null,
  tabs: LayoutTab[],
  activePath: string | null,
  expanded: Set<string>,
): CodeLayout | null {
  if (!workingCopyId) return null;
  return {
    workingCopyId,
    tabs: tabs.map((t) => t.path),
    activePath: activePath ?? "",
    expanded: [...expanded],
  };
}
