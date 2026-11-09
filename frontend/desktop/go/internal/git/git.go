// Package git 是系统 git 的薄封装。
//
// 为什么调系统 git 而不是 go-git：hooks、LFS、签名、用户的 ~/.gitconfig、
// submodule、credential helper 全都是坑，重写一遍不值得。桌面端的价值在于
// "和用户终端里的行为一致"，而不是提供一个行为略异的替代实现。
//
// 这个包只做三件事：拼参数、跑进程、解析输出。**不含业务判断**——
// 能不能提交、该不该 push，由服务端权限裁决。
package git

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// execTimeout 是单条 git 命令的上限。
//
// 大仓库的首次 status 可能偏慢，但不能无限等：界面需要明确的失败，
// 而不是一个永远转圈的加载态。clone/fetch 这类长任务不走这里。
const execTimeout = 30 * time.Second

// ChangeKind 是工作区里一条变更的类别。
type ChangeKind string

const (
	// KindModified 表示文件已修改。
	KindModified ChangeKind = "modified"
	// KindAdded 表示新增并已暂存。
	KindAdded ChangeKind = "added"
	// KindDeleted 表示已删除。
	KindDeleted ChangeKind = "deleted"
	// KindRenamed 表示重命名。
	KindRenamed ChangeKind = "renamed"
	// KindUntracked 表示未跟踪。
	KindUntracked ChangeKind = "untracked"
	// KindConflicted 表示合并冲突。
	KindConflicted ChangeKind = "conflicted"
)

// Change 是工作区里的一条变更。
type Change struct {
	// Path 是相对仓库根的路径（斜杠分隔）。
	Path string `json:"path"`
	// OrigPath 只在重命名/复制时有值。
	OrigPath string `json:"origPath,omitempty"`
	// Kind 是变更类别。
	Kind ChangeKind `json:"kind"`
	// Staged 表示这条改动已进暂存区。
	Staged bool `json:"staged"`
	// Added / Removed 是行数增删。二进制文件为 0：git 不给出行数，
	// 而列表层显示一个假的 0 比显示空更不误导。
	Added   int `json:"added"`
	Removed int `json:"removed"`
}

// StatusResult 是一次工作区扫描的结果。
//
// 命名为 Result 而不是 Status：本包还必须提供一个叫 RepoStatus 的查询函数，
// 类型与函数同名会让调用方写不出 "st, err := Status(dir)" 这种顺手的代码。
type StatusResult struct {
	// Branch 是当前分支名；游离头时为 "HEAD"。
	Branch string `json:"branch"`
	// Dirty 表示有未提交改动。
	Dirty bool `json:"dirty"`
	// Changes 是全部变更（暂存与未暂存混在一起，由 Staged 区分）。
	Changes []Change `json:"changes"`
}

// Branch 是一个本地分支。
type Branch struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
}

// repo 封装在某个目录里跑 git。
func execGit(dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), execTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	// 关掉路径引号与转义：默认 core.quotepath 会把非 ASCII 路径写成
	// "\344\270\255" 这种八进制，读出来就是乱码，后续 git 命令全部对不上。
	// `-z` 只影响 status 的输出，diff 之类仍会转义，因此在进程环境里统一关掉。
	cmd.Env = append(os.Environ(),
		"GIT_OPTIONAL_LOCKS=0",
		"LC_ALL=C.UTF-8",
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=core.quotepath",
		"GIT_CONFIG_VALUE_0=false",
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("git %s 超时（%s）", strings.Join(args, " "), execTimeout)
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return stdout.String(), fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return stdout.String(), nil
}

// gitDir 校验目录并返回其绝对路径。
func checkDir(dir string) (string, error) {
	if strings.TrimSpace(dir) == "" {
		return "", errors.New("目录为空")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("解析路径失败: %w", err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("目录不可访问: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("不是目录: %s", abs)
	}
	return abs, nil
}

// IsRepository 判断目录是否位于一个 git 仓库内（含子目录）。
//
// Args:
//
//	dir: 待检查的目录
//
// Returns:
//
//	是否属于仓库、错误。路径不可访问时返回错误——把它当成"不是仓库"
//	会让用户以为是选错了目录，而实际是路径不存在或没有权限。
func IsRepository(dir string) (bool, error) {
	abs, err := checkDir(dir)
	if err != nil {
		return false, err
	}

	out, err := execGit(abs, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		// 非零退出就是"不是仓库"，这是正常判定结果而非故障。
		return false, nil
	}
	return strings.TrimSpace(out) == "true", nil
}

// Root 返回目录所属仓库的根路径。
func Root(dir string) (string, error) {
	abs, err := checkDir(dir)
	if err != nil {
		return "", err
	}
	out, err := execGit(abs, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// Status 扫描工作区状态。
//
// 用 porcelain=v1 而不是 `git status` 的人类可读输出：后者会随语言环境、
// 终端配色与 git 版本变化，解析它等于给自己挖坑。
//
// Args:
//
//	dir: 仓库内任意目录
//
// Returns:
//
//	分支、是否有改动、变更列表。
func RepoStatus(dir string) (StatusResult, error) {
	abs, err := checkDir(dir)
	if err != nil {
		return StatusResult{}, err
	}

	// -z：以 NUL 分隔，避免路径含空格/换行时的解析歧义。
	// --untracked-files=all：列出未跟踪目录里的具体文件，而不是目录本身。
	out, err := execGit(abs, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return StatusResult{}, err
	}

	st := StatusResult{Changes: parsePorcelainZ(out)}
	st.Dirty = len(st.Changes) > 0

	// 行数统计来自 --numstat：porcelain 本身不含改动量。
	// 两处都要取——未暂存看工作区，已暂存看索引——否则列表里
	// 已暂存的文件会显示成 0。
	attachLineStats(abs, st.Changes)

	if branch, err := currentBranch(abs); err == nil {
		st.Branch = branch
	}
	return st, nil
}

// attachLineStats 为每条变更填上增删行数。
//
// 统计失败不影响状态本身：拿不到行数时显示为空，比让整个 status 失败好。
func attachLineStats(dir string, changes []Change) {
	if len(changes) == 0 {
		return
	}

	// 已暂存看索引，其余看工作区。
	applyNumstat(dir, changes, false, func(c *Change) bool {
		return !c.Staged && c.Kind != KindUntracked
	})
	applyNumstat(dir, changes, true, func(c *Change) bool { return c.Staged })

	// 未跟踪文件不在 `git diff` 的输出里：它还没有被 git 记录，
	// 因此要单独数一遍行数，否则列表里新文件永远显示 0。
	for i := range changes {
		if changes[i].Kind != KindUntracked {
			continue
		}
		added, ok := countFileLines(dir, changes[i].Path)
		if ok {
			changes[i].Added = added
		}
	}
}

// countFileLines 数一个未跟踪文件的行数。
//
// 二进制文件返回 false：给它一个行数是编造的，列表里留空更诚实。
func countFileLines(dir, path string) (int, bool) {
	full := filepath.Join(dir, filepath.FromSlash(path))
	data, err := os.ReadFile(full)
	if err != nil {
		return 0, false
	}
	// 含 NUL 即视为二进制（与 git 的判定一致）。
	if bytes.IndexByte(data, 0) >= 0 {
		return 0, false
	}
	if len(data) == 0 {
		return 0, true
	}
	lines := bytes.Count(data, []byte("\n"))
	// 末行没有换行符时也要算一行。
	if data[len(data)-1] != '\n' {
		lines++
	}
	return lines, true
}

// applyNumstat 跑一次 --numstat 并按匹配规则写入。
func applyNumstat(dir string, changes []Change, cached bool, match func(*Change) bool) {
	args := []string{"diff", "--numstat", "-z"}
	if cached {
		args = append(args, "--cached")
	}
	out, err := execGit(dir, args...)
	if err != nil {
		return
	}

	stats := parseNumstatZ(out)
	for i := range changes {
		if !match(&changes[i]) {
			continue
		}
		if s, ok := stats[changes[i].Path]; ok {
			changes[i].Added = s.added
			changes[i].Removed = s.removed
		}
	}
}

// parseNumstatZ 解析 `git diff --numstat -z` 的输出。
//
// -z 模式下重命名记录形如：
//
//	"ADDED\tREMOVED\t\0OLD\0NEW\0"
//
// 即统计行以空路径结尾，随后是两个 NUL 分隔的路径。
func parseNumstatZ(out string) map[string]struct{ added, removed int } {
	result := make(map[string]struct{ added, removed int })
	fields := strings.Split(out, "\x00")

	for i := 0; i < len(fields); i++ {
		entry := fields[i]
		if entry == "" {
			continue
		}
		parts := strings.SplitN(entry, "\t", 3)
		if len(parts) < 3 {
			continue
		}

		added, removed := parseCount(parts[0]), parseCount(parts[1])
		path := parts[2]

		// 空路径表示这是一条重命名记录：后面两个字段是旧路径与新路径。
		if path == "" && i+2 < len(fields) {
			newPath := fields[i+2]
			result[newPath] = struct{ added, removed int }{added, removed}
			i += 2
			continue
		}
		result[path] = struct{ added, removed int }{added, removed}
	}
	return result
}

// parseCount 解析一行计数；二进制文件的 "-" 视为 0。
func parseCount(s string) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0
	}
	return n
}

// currentBranch 返回当前分支名。
func currentBranch(dir string) (string, error) {
	out, err := execGit(dir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		// 空仓库还没有 HEAD，这不是故障。
		return "", err
	}
	name := strings.TrimSpace(out)
	if name == "" {
		return "", errors.New("空分支名")
	}
	return name, nil
}

// parsePorcelainZ 解析 `git status --porcelain=v1 -z` 的输出。
//
// -z 模式下每条记录以 NUL 结尾；重命名/复制会**多带一个字段**（原路径），
// 因此不能简单地按条切分后逐条解析——那样会把原路径当成下一条记录。
func parsePorcelainZ(out string) []Change {
	fields := strings.Split(out, "\x00")
	changes := make([]Change, 0, len(fields))

	for i := 0; i < len(fields); i++ {
		entry := fields[i]
		if len(entry) < 4 {
			continue
		}
		// 格式：XY<空格>PATH
		xy := entry[:2]
		path := entry[3:]

		c := Change{Path: path}
		c.Kind, c.Staged = classify(xy)

		// 重命名/复制带原路径，紧跟在当前记录之后。
		if strings.ContainsAny(xy, "RC") && i+1 < len(fields) {
			if orig := fields[i+1]; orig != "" {
				c.OrigPath = orig
				i++
			}
		}
		changes = append(changes, c)
	}
	return changes
}

// classify 把 porcelain 的两字符状态码翻译成变更类别与是否已暂存。
//
// 第一位是暂存区状态，第二位是工作区状态。凡是第一位非空/非空格，
// 就说明有内容已进暂存区。
func classify(xy string) (ChangeKind, bool) {
	staged := len(xy) > 0 && xy[0] != ' ' && xy[0] != '?'
	code := xy
	if staged {
		code = string(xy[0])
	} else if len(xy) > 1 {
		code = string(xy[1])
	}

	switch {
	case xy == "??":
		return KindUntracked, false
	case strings.ContainsAny(xy, "U"):
		return KindConflicted, staged
	case strings.Contains(code, "R"):
		return KindRenamed, staged
	case strings.Contains(code, "A"):
		return KindAdded, staged
	case strings.Contains(code, "D"):
		return KindDeleted, staged
	default:
		return KindModified, staged
	}
}

// Branches 列出本地分支。
func Branches(dir string) ([]Branch, error) {
	abs, err := checkDir(dir)
	if err != nil {
		return nil, err
	}

	out, err := execGit(abs, "branch", "--format=%(refname:short)%09%(HEAD)")
	if err != nil {
		return nil, err
	}

	list := make([]Branch, 0)
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		b := Branch{Name: strings.TrimSpace(parts[0])}
		if len(parts) == 2 {
			b.Current = strings.TrimSpace(parts[1]) == "*"
		}
		list = append(list, b)
	}
	return list, nil
}

// AheadBehind 返回当前分支相对上游的领先/落后提交数。
//
// 没有配置上游时返回 0/0 而不是错误：纯本地仓库是常态，
// 把它当失败会让界面显示一个假的错误。
func AheadBehind(dir string) (int, int, error) {
	abs, err := checkDir(dir)
	if err != nil {
		return 0, 0, err
	}

	out, err := execGit(abs, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
	if err != nil {
		return 0, 0, nil
	}

	parts := strings.Fields(strings.TrimSpace(out))
	if len(parts) != 2 {
		return 0, 0, nil
	}
	ahead, err1 := strconv.Atoi(parts[0])
	behind, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return 0, 0, nil
	}
	return ahead, behind, nil
}

// Stage 把指定路径加入暂存区。
//
// Args:
//
//	dir:   仓库目录
//	paths: 相对仓库根的路径列表
//
// 用 `--` 分隔路径：路径以 `-` 开头时（例如 `-weird.txt`）不会被当成选项。
func Stage(dir string, paths []string) error {
	abs, err := checkDir(dir)
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		return errors.New("没有要暂存的路径")
	}
	args := append([]string{"add", "--"}, paths...)
	_, err = execGit(abs, args...)
	return err
}

// Unstage 把指定路径移出暂存区（保留工作区改动）。
func Unstage(dir string, paths []string) error {
	abs, err := checkDir(dir)
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		return errors.New("没有要取消暂存的路径")
	}
	// reset 需要指定 HEAD 作为目标；空仓库时用 --hard 之外的路径语义会失败，
	// 因此回退到 `rm --cached`。
	if _, err := execGit(abs, append([]string{"reset", "HEAD", "--"}, paths...)...); err != nil {
		_, err = execGit(abs, append([]string{"rm", "--cached", "--quiet", "--"}, paths...)...)
		return err
	}
	return nil
}

// Commit 提交暂存区内容。
//
// Args:
//
//	dir:       仓库目录
//	message:   提交信息（不能为空）
//	amend:     是否修补上一次提交
//
// Returns:
//
//	提交信息为空、没有暂存内容或 git 拒绝时返回错误。
func Commit(dir, message string, amend bool) error {
	abs, err := checkDir(dir)
	if err != nil {
		return err
	}
	if strings.TrimSpace(message) == "" {
		return errors.New("提交信息不能为空")
	}

	args := []string{"commit", "-m", message}
	if amend {
		args = append(args, "--amend")
	}
	_, err = execGit(abs, args...)
	return err
}

// FileDiff 返回单个文件的 diff。
//
// Args:
//
//	dir:    仓库目录
//	path:   相对仓库根的路径
//	staged: true 读暂存区相对 HEAD 的差异，false 读工作区相对暂存区的差异
//
// Returns:
//
//	统一 diff 文本。未跟踪文件没有暂存版本，走"与空文件比较"给出
//	整份新增的形态——用户需要看到新文件内容，而不是一个空字符串。
func FileDiff(dir, path string, staged bool) (string, error) {
	abs, err := checkDir(dir)
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", errors.New("路径为空")
	}

	if staged {
		return execGit(abs, "diff", "--cached", "--", path)
	}

	// 未跟踪文件：git diff 对它没有输出。用 --no-index 与空设备比较，
	// 得到"整份文件都是新增"的 diff。
	tracked, err := isTracked(abs, path)
	if err == nil && !tracked {
		out, diffErr := execGit(abs, "diff", "--no-index", "--", os.DevNull, path)
		if diffErr != nil && strings.TrimSpace(out) == "" {
			return "", diffErr
		}
		return out, nil
	}

	return execGit(abs, "diff", "--", path)
}

// isTracked 判断文件是否被 git 跟踪。
func isTracked(dir, path string) (bool, error) {
	out, err := execGit(dir, "ls-files", "--error-unmatch", "--", path)
	if err != nil {
		return false, nil
	}
	return strings.TrimSpace(out) != "", nil
}

// CurrentBranch 是对外暴露的当前分支查询。
func CurrentBranch(dir string) (string, error) {
	abs, err := checkDir(dir)
	if err != nil {
		return "", err
	}
	return currentBranch(abs)
}
