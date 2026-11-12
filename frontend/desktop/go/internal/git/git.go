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

	"github.com/kustos/kustos-desktop/internal/platform/noconsole"
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
	// HasUnstaged 表示工作区侧还有未进暂存区的改动。
	//
	// 逐 hunk 暂存之后，同一个文件可以一半在 index、一半还在工作树
	// （porcelain 的 `MM`）。只用 Staged 分栏会让它只出现在 Staged 组，
	// 剩下那块就从列表里消失了——而它恰恰是用户下一步要处理的东西。
	HasUnstaged bool `json:"hasUnstaged"`
	// Added / Removed 是行数增删。二进制文件为 0：git 不给出行数，
	// 而列表层显示一个假的 0 比显示空更不误导。
	//
	// 已暂存与未暂存的同一文件会各自成一行，两行都得显示自己那一侧的量：
	// Added/Removed 沿用它所在侧的语义（Staged 为真时看 index，否则看工作树），
	// UnstagedAdded/Removed 只在两侧都有改动时补上工作树那一侧的数字。
	Added           int `json:"added"`
	Removed         int `json:"removed"`
	UnstagedAdded   int `json:"unstagedAdded"`
	UnstagedRemoved int `json:"unstagedRemoved"`
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
	cmd.Env = gitEnv()
	noconsole.Hide(cmd)

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

// gitEnv 是所有 git 子进程共用的环境。
//
// 关掉路径引号与转义：默认 core.quotepath 会把非 ASCII 路径写成
// "\344\270\255" 这种八进制，读出来就是乱码，后续 git 命令全部对不上。
// `-z` 只影响 status 的输出，diff 之类仍会转义，因此在进程环境里统一关掉。
//
// GIT_OPTIONAL_LOCKS=0：只读命令（status/diff）不要去抢 index.lock，
// 否则外部编辑器同时跑 git 时会互相干扰。
func gitEnv() []string {
	return append(os.Environ(),
		"GIT_OPTIONAL_LOCKS=0",
		"LC_ALL=C.UTF-8",
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=core.quotepath",
		"GIT_CONFIG_VALUE_0=false",
	)
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
		c.HasUnstaged = hasUnstaged(xy)

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

// hasUnstaged 判断工作区侧是否还有未进暂存区的改动。
//
// 只看第二位：`MM` 与 `AM` 都是"一半已暂存、一半还在工作树"，
// 这正是逐 hunk 暂存产生的常态。未跟踪（`??`）不适用——它两侧都不在，
// 由 Kind 单独成组。
func hasUnstaged(xy string) bool {
	if len(xy) < 2 || xy == "??" {
		return false
	}
	return xy[1] != ' '
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

/* ------------------------------------------------------------------ */
/* 远端同步                                                            */
/* ------------------------------------------------------------------ */

// networkTimeout 是联网类 git 命令的上限。
//
// 比本地命令宽松得多：push/fetch 要走网络，自托管实例可能在 VPN 后面，
// 30 秒内没完成是常态而非故障。但也不能无限等——界面要能给出明确失败。
const networkTimeout = 3 * time.Minute

// execGitNetwork 与 execGit 相同，但用网络超时。
func execGitNetwork(dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), networkTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	noconsole.Hide(cmd)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("git %s 超时（%s）", strings.Join(args, " "), networkTimeout)
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return stdout.String(), fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return stdout.String(), nil
}

// PushCommand 返回将要执行的 push 命令，供确认框展示。
//
// 破坏性操作必须让用户看到**完整命令**再确认——"确认强制推送？"这种问法
// 无法让人判断后果，而 `git push --force-with-lease` 能。
//
// Args:
//
//	dir:   仓库目录
//	force: 是否强制推送
//
// Returns:
//
//	可读的命令字符串。拿不到上游时给出不含远端名的通用形式，
//	而不是返回空串——确认框里空白比写明"不知道远端"更糟。
func PushCommand(dir string, force bool) string {
	abs, err := checkDir(dir)
	if err != nil {
		return "git push"
	}

	remote, branch := upstreamInfo(abs)
	parts := []string{"git", "push"}
	if force {
		parts = append(parts, "--force-with-lease")
	}
	if remote != "" && branch != "" {
		parts = append(parts, remote, branch)
	}
	return strings.Join(parts, " ")
}

// Push 把当前分支推送到上游。
//
// Args:
//
//	dir:   仓库目录
//	force: 是否强制推送；用 `--force-with-lease` 而不是 `--force`，
//	       前者在远端已被别人更新时会拒绝，避免覆盖他人的提交
//
// Returns:
//
//	没有上游、没有提交、凭证缺失或被远端拒绝时返回可读错误。
//
// 用系统 git 的凭证机制（credential helper / SSH agent）：桌面端不接触
// 也不存储远端密码，那正是用户机器上已经配置好的东西。
func Push(dir string, force bool) error {
	abs, err := checkDir(dir)
	if err != nil {
		return err
	}

	args := []string{"push"}
	if force {
		args = append(args, "--force-with-lease")
	}
	_, err = execGitNetwork(abs, args...)
	return err
}

// Fetch 从上游拉取引用（不改工作区）。
func Fetch(dir string) error {
	abs, err := checkDir(dir)
	if err != nil {
		return err
	}
	_, err = execGitNetwork(abs, "fetch", "--prune")
	return err
}

// upstreamInfo 返回当前分支的上游远端与分支名；没有上游时返回空串。
func upstreamInfo(dir string) (remote, branch string) {
	out, err := execGit(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	if err != nil {
		return "", ""
	}
	full := strings.TrimSpace(out)
	// 形如 "origin/main"；远端名本身可能含斜杠的情况极罕见，按第一段切分。
	idx := strings.Index(full, "/")
	if idx <= 0 || idx == len(full)-1 {
		return "", ""
	}
	return full[:idx], full[idx+1:]
}

// Upstream 描述当前分支的上游远端。
//
// 为什么需要它：桌面端要回答"这个本地目录对应服务端哪个仓库"，而这个对应
// 关系只存在于 remote 地址里（`owner/repo` 片段）。有了 remote 名与 URL，
// 前端才能把工作副本关联到服务端的仓库记录上，PR 与 Issue 面才有东西可取。
type Upstream struct {
	// Name 是远端名（通常是 origin）；没有上游时为空。
	Name string `json:"name"`
	// URL 是该远端的原始地址；没有上游或取不到时为空。
	URL string `json:"url"`
}

// RemoteInfo 返回当前分支上游远端的名字与地址。
//
// 只读当前分支的上游，不遍历所有远端：用户关心的是"我 push 到哪里"，
// 而不是 `git remote -v` 的完整清单。
//
// 有上游时直接用上游的远端。**没有上游时回落到 origin，再回落到第一个远端**：
// 刚 clone 但还没建立跟踪、或者 clone 后 checkout 了本地新建分支，都只有
// `origin` 而没有上游。此时返回空值会让前端无法把这个目录关联到服务端的
// 仓库，PR 与 Issue 面跟着一起空掉——而用户明明就站在那个仓库里。
//
// Args:
//
//	dir: 仓库目录（子目录会被收敛到仓库根）
//
// Returns:
//
//	远端名与地址；仓库完全没有远端时两者皆为空字符串，不报错
//	——"这个仓库还没接远端"是正常状态。
func RemoteInfo(dir string) Upstream {
	abs, err := checkDir(dir)
	if err != nil {
		return Upstream{}
	}

	if name, _ := upstreamInfo(abs); name != "" {
		return Upstream{Name: name, URL: RemoteURL(abs, name)}
	}

	for _, name := range remoteNames(abs) {
		if url := RemoteURL(abs, name); url != "" {
			return Upstream{Name: name, URL: url}
		}
	}
	return Upstream{}
}

// remoteNames 返回仓库配置的远端名，origin 排在最前。
//
// 排序理由：多远端时 origin 是用户心智里"这个仓库的正主"，
// 其余（upstream、同事的 fork）都是附加的。
func remoteNames(dir string) []string {
	out, err := execGit(dir, "remote")
	if err != nil {
		return nil
	}

	var names []string
	for _, line := range strings.Split(out, "\n") {
		name := strings.TrimSpace(line)
		if name == "" {
			continue
		}
		if name == "origin" {
			return append([]string{"origin"}, names...)
		}
		names = append(names, name)
	}
	return names
}

// RemoteURL 返回指定远端的地址；没有该远端时返回空串。
func RemoteURL(dir, name string) string {
	abs, err := checkDir(dir)
	if err != nil {
		return ""
	}
	out, err := execGit(abs, "remote", "get-url", name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}
