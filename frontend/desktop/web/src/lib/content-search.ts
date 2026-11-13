import { useQuery } from "@tanstack/react-query";

import { WorkingCopyService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";
import type { ContentSearchQuery } from "@/bindings/github.com/kustos/kustos-desktop/internal/services/models";
import type { ContentMatch } from "@/bindings/github.com/kustos/kustos-desktop/internal/git/models";

/**
 * 工作树全文搜索的数据层。
 *
 * 与 `useFileSearch`（按路径找文件）是两个问题：这里回答"这段逻辑写在哪儿"。
 * Go 侧用 `git grep` 现扫工作树，不建本地索引——桌面端刻意没有文件监听，
 * 一份会过期的索引比慢更糟（行号跳到不存在的位置）。
 */

export const contentSearchKeys = {
  results: (id: string, q: ContentSearchQuery) =>
    ["content-search", id, q.query, q.regex, q.caseSensitive, q.path, q.limit] as const,
};

/** 单次搜索的命中上限；与 Go 侧默认值同量级，界面不做二次截断。 */
export const CONTENT_SEARCH_LIMIT = 500;

/** 至少输入这么多个字符才真的扫一遍工作树：单字符查询在仓库里命中成千上万行。 */
export const MIN_CONTENT_QUERY = 2;

/**
 * 该不该发起搜索。
 *
 * 去抖后的查询仍要过这道闸：长度不够时界面显示的是上一次的占位提示，
 * 而不是转着圈等一次注定被截断的全仓库扫描。
 */
export function shouldSearchContent(query: string): boolean {
  return query.trim().length >= MIN_CONTENT_QUERY;
}

/** 把界面状态收敛成一次查询参数。 */
export function buildContentQuery(vars: {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  scope: string;
}): ContentSearchQuery {
  return {
    query: vars.query.trim(),
    regex: vars.regex,
    caseSensitive: vars.caseSensitive,
    path: vars.scope.trim(),
    limit: CONTENT_SEARCH_LIMIT,
  };
}

/** 命中列表按文件分组后的一个文件段。 */
export interface FileHits {
  path: string;
  matches: ContentMatch[];
}

/**
 * 把命中按文件分组，保持 git 给出的顺序（文件名字序、文件内行号序）。
 *
 * 结果列表按文件分节显示：几十条命中平铺时，"集中在哪几个文件"这个
 * 最重要的信息反而看不见。
 */
export function groupMatchesByFile(matches: ContentMatch[]): FileHits[] {
  const groups: FileHits[] = [];
  for (const m of matches) {
    const last = groups[groups.length - 1];
    // 只与上一组比较：git 的输出按文件聚集，跨文件重新出现的同名路径
    // 不该并进第一段（那会跳着显示行号，反而更像 bug）。
    if (last && last.path === m.path) {
      last.matches.push(m);
      continue;
    }
    groups.push({ path: m.path, matches: [m] });
  }
  return groups;
}

/** 查询在该行里的一个匹配区间（0 起，end 不含）。 */
export interface MatchRange {
  start: number;
  end: number;
}

/** 单行参与高亮的区间上限：防一个灾难性回溯的正则把渲染拖死。 */
const MAX_RANGES_PER_LINE = 32;

/**
 * 计算一行文本里查询命中的区间，用于结果行的高亮。
 *
 * 字面量查询直接按大小写规则找子串；正则查询整行过一次。
 * **坏正则返回空区间而不是抛错**：高亮是锦上添花，输入过程中的半个
 * 正则不该把整条结果列表炸掉（服务端错误已经由查询错误态表达）。
 */
export function highlightRanges(
  text: string,
  query: string,
  opts: { regex: boolean; caseSensitive: boolean },
): MatchRange[] {
  const needle = query.trim();
  if (needle === "" || text === "") return [];

  if (opts.regex) {
    const flags = opts.caseSensitive ? "g" : "gi";
    let re: RegExp;
    try {
      re = new RegExp(needle, flags);
    } catch {
      return [];
    }
    const ranges: MatchRange[] = [];
    let m: RegExpExecArray | null;
    // 零宽匹配必须前进一格，否则 lastIndex 不动会原地死循环。
    while ((m = re.exec(text)) !== null) {
      if (m[0] === "") {
        re.lastIndex += 1;
        continue;
      }
      ranges.push({ start: m.index, end: m.index + m[0].length });
      if (ranges.length >= MAX_RANGES_PER_LINE) break;
    }
    return ranges;
  }

  const hay = opts.caseSensitive ? text : text.toLowerCase();
  const nd = opts.caseSensitive ? needle : needle.toLowerCase();
  const ranges: MatchRange[] = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(nd, from);
    if (idx < 0) break;
    ranges.push({ start: idx, end: idx + nd.length });
    if (ranges.length >= MAX_RANGES_PER_LINE) break;
    from = idx + nd.length;
  }
  return ranges;
}

/**
 * 全文搜索查询。
 *
 * 失败保留上一次结果（placeholderData）：边打字边清空列表没法读。
 * 不重试——搜索失败（非法正则、超时、目录没了）都是确定性结果，
 * 重试只会再扫一遍工作树。
 */
export function useContentSearch(
  workingCopyId: string | null,
  vars: { query: string; regex: boolean; caseSensitive: boolean; scope: string },
  enabled = true,
) {
  const q = buildContentQuery(vars);
  return useQuery({
    queryKey: contentSearchKeys.results(workingCopyId ?? "", q),
    queryFn: () =>
      WorkingCopyService.SearchContent(workingCopyId as string, q) as Promise<{
        matches: ContentMatch[] | null;
        truncated: boolean;
      }>,
    enabled: Boolean(workingCopyId) && enabled && shouldSearchContent(q.query),
    staleTime: 10_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
}
