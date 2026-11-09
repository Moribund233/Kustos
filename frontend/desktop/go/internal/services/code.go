package services

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/kustos/kustos-desktop/internal/git"
)

// Code 面的本地能力：列举工作树、读文件内容。
//
// 边界与工作副本一致——只回答"本机文件是什么"，不做权限判断。
// 但这里多一条硬约束：**所有路径必须收敛在仓库根之内**。前端传来的是
// 字符串，直接拼进 filepath.Join 会让 `../../etc/passwd` 读到仓库外的文件。
// 路径校验统一走 resolveInside（见 workingcopy.go），不在此处重复实现。

const (
	// maxReadableBytes 是单文件读取上限。
	//
	// 把 500MB 的日志读进 WebView 会直接卡死渲染进程，而用户点开它的
	// 真实目的通常只是"看看最后几行"。超限时明确拒绝，比装作能打开好。
	maxReadableBytes = 2 << 20 // 2 MiB

	// dirListLimit 是单层目录的条目上限。
	//
	// node_modules 之类目录可以有上万个条目，一次性全发给前端会让树卡住。
	dirListLimit = 2000
)

// TreeNode 是文件树上的一个节点。
type TreeNode struct {
	// Name 是显示名（不含路径）。
	Name string `json:"name"`
	// Path 是相对仓库根的路径（斜杠分隔），前端据此请求下一层。
	Path string `json:"path"`
	// IsDir 区分目录与文件。
	IsDir bool `json:"isDir"`
	// Size 是文件字节数；目录为 0。
	Size int64 `json:"size"`
	// Status 是工作区变更标记（M/A/D/U…），无改动时为空。
	Status string `json:"status"`
}

// skipDirNames 是不在树里展开的目录。
//
// `.git` 里有上万个松散对象，展开等于把界面刷爆；其余是构建与依赖产物，
// 对"读代码"没有价值，且数量级同样夸张。
var skipDirNames = map[string]bool{
	".git":         true,
	"node_modules": true,
	".venv":        true,
	"venv":         true,
	"__pycache__":  true,
	".next":        true,
	"dist":         true,
	"target":       true,
	".idea":        true,
	".vscode":      true,
}

// ListTree 列举仓库内某一层目录。
//
// Args:
//
//	id:   工作副本 ID
//	path: 相对仓库根的目录路径；空串表示仓库根
//
// Returns:
//
//	该层的节点列表，目录在前、各自按名称排序。
//	路径越界、不是目录或不存在时返回错误。
func (s *WorkingCopyService) ListTree(id, path string) ([]TreeNode, error) {
	wc, err := s.get(id)
	if err != nil {
		return nil, err
	}

	dir, err := resolveInside(wc.Path, path, true)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("读取目录失败: %w", err)
	}

	// 一次性的工作区状态：给每个文件打变更标记。
	// 失败不影响列举——状态标记是锦上添花，拿不到就都不标。
	statusByPath := map[string]string{}
	if st, stErr := git.RepoStatus(wc.Path); stErr == nil {
		for _, c := range st.Changes {
			statusByPath[c.Path] = statusLetter(c.Kind)
		}
	}

	nodes := make([]TreeNode, 0, min(len(entries), dirListLimit))
	for _, entry := range entries {
		if len(nodes) >= dirListLimit {
			break
		}
		name := entry.Name()
		if entry.IsDir() && skipDirNames[name] {
			continue
		}

		rel := name
		if path != "" {
			rel = strings.TrimSuffix(path, "/") + "/" + name
		}

		node := TreeNode{
			Name:   name,
			Path:   rel,
			IsDir:  entry.IsDir(),
			Status: statusByPath[rel],
		}
		if info, infoErr := entry.Info(); infoErr == nil && !entry.IsDir() {
			node.Size = info.Size()
		}
		nodes = append(nodes, node)
	}

	// 目录在前、再按名称排序：与所有主流文件树一致，
	// 用户扫视时不用在两套顺序之间切换。
	sort.SliceStable(nodes, func(i, j int) bool {
		if nodes[i].IsDir != nodes[j].IsDir {
			return nodes[i].IsDir
		}
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})

	return nodes, nil
}

// ReadFile 读取仓库内某个文件的内容。
//
// Args:
//
//	id:   工作副本 ID
//	path: 相对仓库根的路径
//
// Returns:
//
//	文件文本内容。越界、不存在、二进制或超过 maxReadableBytes 时返回错误。
//
// 二进制与超大文件都**明确拒绝**而不是截断：界面上渲染一堆乱码或半个文件，
// 比一句"这个文件打不开"更让人困惑。
func (s *WorkingCopyService) ReadFile(id, path string) (string, error) {
	wc, err := s.get(id)
	if err != nil {
		return "", err
	}

	abs, err := resolveInside(wc.Path, path, false)
	if err != nil {
		return "", err
	}

	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("读取文件失败: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("这是一个目录，不是文件: %s", path)
	}
	if info.Size() > maxReadableBytes {
		return "", fmt.Errorf(
			"文件过大（%d KiB，上限 %d KiB）",
			info.Size()/1024, maxReadableBytes/1024,
		)
	}

	data, err := os.ReadFile(abs)
	if err != nil {
		return "", fmt.Errorf("读取文件失败: %w", err)
	}

	if !isTextContent(data) {
		return "", errors.New("这是一个二进制文件，不当作文本打开")
	}

	return string(data), nil
}

// isTextContent 判断内容是否可作为文本显示。
//
// 判定用"含 NUL 或不是合法 UTF-8"：与 git 的二进制判定同源，
// 也与"用户能不能读"这个实际标准一致。只看扩展名会漏掉没有后缀的
// 可执行文件，也会误杀没有后缀的纯文本。
func isTextContent(data []byte) bool {
	if len(data) == 0 {
		return true
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return false
	}
	// 只看前 8KB：大文件尾部有非 UTF-8 内容（例如混入了 latin-1 注释）
	// 不该让整份文件无法打开。
	sample := data
	if len(sample) > 8192 {
		sample = sample[:8192]
	}
	// 末尾可能截断在多字节字符中间，去掉不完整的尾部再判定。
	for len(sample) > 0 && !utf8.Valid(sample) {
		sample = sample[:len(sample)-1]
	}
	return len(sample) > 0 || len(data) == 0
}

// ListChanges 返回仓库内所有变更文件。
//
// 树形浏览适合"我要找某个文件"，但改代码时用户想的是"我改了哪些文件"，
// 那是另一个入口——让他在树里逐层找自己刚改过的文件是反的。
//
// Returns:
//
//	与文件树同构的节点列表（路径相对仓库根），按路径排序。
func (s *WorkingCopyService) ListChanges(id string) ([]TreeNode, error) {
	wc, err := s.get(id)
	if err != nil {
		return nil, err
	}

	st, err := git.RepoStatus(wc.Path)
	if err != nil {
		return nil, err
	}

	nodes := make([]TreeNode, 0, len(st.Changes))
	for _, c := range st.Changes {
		nodes = append(nodes, TreeNode{
			Name:   baseNameOf(c.Path),
			Path:   c.Path,
			IsDir:  false,
			Status: statusLetter(c.Kind),
		})
	}

	sort.SliceStable(nodes, func(i, j int) bool {
		return strings.ToLower(nodes[i].Path) < strings.ToLower(nodes[j].Path)
	})
	return nodes, nil
}

// SearchFiles 按文件名或路径片段搜索工作树。
//
// Args:
//
//	id:    工作副本 ID
//	query: 搜索片段（大小写不敏感）；空白查询直接返回空结果
//	limit: 结果上限；<= 0 时用默认值
//
// Returns:
//
//	命中的文件节点，路径相对仓库根。
//
// 用户不记得文件在哪个目录时，逐层展开是找不动的。搜索只看路径，
// 不读文件内容——全文检索是另一个量级的工程，而"找文件"这个诉求
// 用路径匹配已经够用。
func (s *WorkingCopyService) SearchFiles(id, query string, limit int) ([]TreeNode, error) {
	wc, err := s.get(id)
	if err != nil {
		return nil, err
	}

	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		// 空查询返回空结果而不是整棵树：界面在用户还没输入时
		// 不应该先做一次全树遍历。
		return []TreeNode{}, nil
	}
	if limit <= 0 {
		limit = searchLimit
	}

	results := make([]TreeNode, 0, min(limit, 64))
	walkErr := filepath.WalkDir(wc.Path, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			// 单个目录不可读不该中断整个搜索：权限问题在工作树里很常见。
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			if skipDirNames[entry.Name()] {
				return filepath.SkipDir
			}
			return nil
		}

		rel, relErr := filepath.Rel(wc.Path, path)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)

		if !strings.Contains(strings.ToLower(rel), needle) {
			return nil
		}

		results = append(results, TreeNode{
			Name: entry.Name(),
			Path: rel,
		})
		if len(results) >= limit {
			return errStopWalk
		}
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, errStopWalk) {
		return nil, fmt.Errorf("搜索文件失败: %w", walkErr)
	}

	sort.SliceStable(results, func(i, j int) bool {
		return strings.ToLower(results[i].Path) < strings.ToLower(results[j].Path)
	})
	return results, nil
}

// searchLimit 是搜索结果的默认上限。
const searchLimit = 200

// errStopWalk 用于在达到上限时提前结束遍历。
var errStopWalk = errors.New("搜索已达到上限")

// baseNameOf 返回路径最后一段（Windows 与 POSIX 分隔符都处理）。
func baseNameOf(path string) string {
	parts := strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' })
	if len(parts) == 0 {
		return path
	}
	return parts[len(parts)-1]
}

// statusLetter 把变更类别映射成单字母状态码（对齐 git 习惯）。
func statusLetter(kind git.ChangeKind) string {
	switch kind {
	case git.KindAdded:
		return "A"
	case git.KindDeleted:
		return "D"
	case git.KindRenamed:
		return "R"
	case git.KindUntracked:
		return "U"
	case git.KindConflicted:
		return "!"
	case git.KindModified:
		return "M"
	default:
		return ""
	}
}

// min 返回两个整数中较小的一个。
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// 确保 filepath 被使用（resolveInside 在另一文件里用它，这里保持一致性说明）。
var _ = filepath.Join
