package services

import (
	"fmt"
	"strings"

	"github.com/kustos/kustos-desktop/internal/git"
)

// 工作树全文内容搜索。
//
// 与 SearchFiles（只匹配路径）是两个问题：路径搜索回答"文件叫什么"，
// 内容搜索回答"这段逻辑写在哪儿"。后者靠 `git grep` 现扫（见 internal/git/grep.go
// 里为什么不建本地索引的说明）。
//
// 边界与 Code 面一致：只回答"本机工作树里有什么"，且目录前缀必须收敛在
// 仓库根之内——路径是前端传来的字符串，越界一律拒绝。

// ContentSearchQuery 是一次全文搜索的参数。
type ContentSearchQuery struct {
	// Query 是查询文本；空或纯空白返回空结果。
	Query string `json:"query"`
	// Regex 为真时按扩展正则解释，否则按字面量。
	Regex bool `json:"regex"`
	// CaseSensitive 为真时区分大小写。
	CaseSensitive bool `json:"caseSensitive"`
	// Path 是可选的目录/文件前缀（相对仓库根）；空表示全仓库。
	Path string `json:"path"`
	// Limit 是总命中上限；<= 0 时用默认值。
	Limit int `json:"limit"`
}

// ContentSearchResult 是一次全文搜索的结果。
type ContentSearchResult struct {
	// Matches 是命中列表（文件名字序、文件内行号序）。
	Matches []git.ContentMatch `json:"matches"`
	// Truncated 表示触到了上限、结果不完整；界面据此提示缩小范围。
	Truncated bool `json:"truncated"`
}

// SearchContent 在工作树里做全文搜索。
//
// Args:
//
//	id: 工作副本 ID
//	q:  查询参数
//
// Returns:
//
//	命中列表与截断标记。空白查询返回空结果；非法正则、目录前缀越界、
//	搜索超时返回错误。"没有命中"是空结果不是错误。
//
// 与联网命令不同，这里不进工作树锁：git grep 只读，且一次宽泛查询可能跑
// 十几秒，把它挡在提交与暂存前面是纯粹的伤害。
func (s *WorkingCopyService) SearchContent(id string, q ContentSearchQuery) (ContentSearchResult, error) {
	wc, err := s.get(id)
	if err != nil {
		return ContentSearchResult{}, err
	}

	// 目录前缀收敛在仓库内（含仓库根）。存在性一并校验：搜一个不存在的
	// 目录多半是界面拿着旧的展开状态，报错比返回空更诚实。
	if strings.TrimSpace(q.Path) != "" {
		if _, err := resolveInside(wc.Path, q.Path, false); err != nil {
			return ContentSearchResult{}, err
		}
	}

	res, err := git.GrepContent(wc.Path, git.GrepRequest{
		Query:         q.Query,
		Regex:         q.Regex,
		CaseSensitive: q.CaseSensitive,
		Path:          q.Path,
		MaxMatches:    q.Limit,
	})
	if err != nil {
		return ContentSearchResult{}, fmt.Errorf("全文搜索失败: %w", err)
	}
	return ContentSearchResult{Matches: res.Matches, Truncated: res.Truncated}, nil
}
