package git

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"

	"github.com/kustos/kustos-desktop/internal/platform/noconsole"
)

// 逐 hunk 暂存。
//
// 为什么用 `git apply --cached` 而不是自己写 index：index 的二进制格式里
// 连着 stat 信息（ctime/mtime/dev/inode），写错一位就会让 git 把"根本没改过"
// 的文件报成已修改，而且这类损坏用户无从排查。让 git 自己去写 index，
// 我们只负责把"用户选中的那一块"变成一个合法的最小 patch。
//
// 关键约束是 header 陈旧性校验：界面里的 hunk 列表是一次快照，用户点下按钮时
// 文件可能已经被外部编辑器、构建脚本或另一次暂存改动过，行号随之漂移。
// Go 侧重新读到的 diff 里如果找不到那个 header，只能报错让界面刷新——
// "就近猜一个 hunk"的后果是把用户没打算提交的内容写进 index，
// 提交之后他很难发现多进去的是什么。

// hunkRangeRe 匹配 hunk 头的区间部分：`@@ -112,7 +112,9 @@`。
//
// hunk 头后面可能跟着函数名上下文（git 的默认行为），比对时只取这一段：
// 界面原样显示整行，但函数名里的空格与逗号会让"原文相等"这种判断很脆弱。
var hunkRangeRe = regexp.MustCompile(`^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@`)

// hunkRange 取出一行 hunk 头里的区间部分；不是 hunk 头时返回 false。
func hunkRange(line string) (string, bool) {
	m := hunkRangeRe.FindString(line)
	if m == "" {
		return "", false
	}
	return m, true
}

// StageHunk 把某文件中指定的一个 hunk 写进暂存区。
//
// Args:
//
//	dir:    仓库目录
//	path:   相对仓库根的路径
//	header: 界面里那个 hunk 的头原文，例如 `@@ -112,7 +112,9 @@`
//
// Returns:
//
//	header 在当前 diff 里找不到、文件未跟踪、没有未暂存改动或 git 拒绝时返回错误。
//
// header 不只是定位手段，也是陈旧性校验：拿它匹配失败就说"列表过期了"，
// 绝不退化成"暂存最接近的那一块"。
func StageHunk(dir, path, header string) error {
	abs, err := checkDir(dir)
	if err != nil {
		return err
	}
	if err := checkHunkArgs(path, header); err != nil {
		return err
	}

	// 未跟踪文件在 index 里没有对应版本，"这一块的反向 patch"无从谈起：
	// 对它做 hunk 级暂存的唯一正确做法是先把整个文件加进去。
	tracked, err := isTracked(abs, path)
	if err != nil {
		return err
	}
	if !tracked {
		return fmt.Errorf("文件未跟踪，没有可逐块暂存的差异；请先整文件暂存: %s", path)
	}

	diffText, err := execGit(abs, "diff", "--", path)
	if err != nil {
		return err
	}
	if strings.TrimSpace(diffText) == "" {
		return fmt.Errorf("没有未暂存的改动可暂存: %s", path)
	}

	patch, err := extractHunkPatch(diffText, header)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if err := applyPatch(abs, patch, false); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

// UnstageHunk 把暂存区里指定的一个 hunk 撤回工作区侧（不丢弃改动）。
//
// Args 与 StageHunk 相同；header 同样充当陈旧性校验。
func UnstageHunk(dir, path, header string) error {
	abs, err := checkDir(dir)
	if err != nil {
		return err
	}
	if err := checkHunkArgs(path, header); err != nil {
		return err
	}

	tracked, err := isTracked(abs, path)
	if err != nil {
		return err
	}
	if !tracked {
		return fmt.Errorf("文件未跟踪，不在暂存区里；请整文件取消暂存: %s", path)
	}

	diffText, err := execGit(abs, "diff", "--cached", "--", path)
	if err != nil {
		return err
	}
	if strings.TrimSpace(diffText) == "" {
		return fmt.Errorf("暂存区没有该文件的改动: %s", path)
	}

	patch, err := extractHunkPatch(diffText, header)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if err := applyPatch(abs, patch, true); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

// checkHunkArgs 拦住最没信息量的两种输入。
//
// header 为空时不能当成"第一个 hunk"：那等于替用户做了一个他没做过的选择。
func checkHunkArgs(path, header string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("路径为空")
	}
	if strings.TrimSpace(header) == "" {
		return errors.New("缺少 hunk 头")
	}
	return nil
}

/* ------------------------------------------------------------------ */
/* patch 拼装                                                          */
/* ------------------------------------------------------------------ */

// fileSection 是一个文件在 diff 里的区段。
type fileSection struct {
	// head 是 hunk 之前的部分：`diff --git`、mode、index、`---`/`+++`。
	// git apply 靠它认文件与权限，缺了就是一句 "unrecognized input"。
	head []string
	// lines 是 head 之后的全部行（所有 hunk）。
	lines []string
}

// extractHunkPatch 从一份 diff 文本里切出"文件头 + 单个 hunk"的最小 patch。
//
// Args:
//
//	diffText: `git diff [--cached] -- <path>` 的原文
//	header:   目标 hunk 的头原文
//
// Returns:
//
//	可直接喂给 `git apply` 的 patch（以换行结尾）。找不到、匹配到多处、
//	或该文件涉及重命名/复制时返回错误。
//
// 匹配到多处也算失败：同一次点击只该对应一块内容，歧义时宁可让用户刷新。
func extractHunkPatch(diffText, header string) (string, error) {
	target, ok := hunkRange(header)
	if !ok {
		return "", fmt.Errorf("不是合法的 hunk 头: %q", strings.TrimSpace(header))
	}

	lines := splitDiffLines(diffText)
	if len(lines) == 0 {
		return "", binaryOrEmptyError(diffText)
	}

	var found []string
	var matched fileSection
	count := 0

	for _, sec := range splitFileSections(lines) {
		hunk := findHunkLines(sec, target)
		if len(hunk) == 0 {
			continue
		}
		count++
		if err := rejectRename(sec); err != nil {
			return "", err
		}
		found = hunk
		matched = sec
	}

	switch {
	case count == 0:
		return "", binaryOrEmptyError(diffText)
	case count > 1:
		return "", fmt.Errorf("hunk %s 在当前 diff 里匹配到多处，无法确定要操作哪一块，请刷新后重试", target)
	}

	patch := strings.Join(append(append([]string{}, matched.head...), found...), "\n")
	return patch + "\n", nil
}

// binaryOrEmptyError 把"没有可用 hunk"的两种真实原因说清楚。
func binaryOrEmptyError(diffText string) error {
	if strings.Contains(diffText, "Binary files") || strings.Contains(diffText, "GIT binary patch") {
		return errors.New("二进制文件没有逐行差异，请整文件暂存")
	}
	return errors.New("在当前 diff 里找不到这个 hunk；文件内容可能已被改动，请刷新后重试")
}

// rejectNames 拒绝带重命名/复制的区段——见调用处注释。
func rejectRename(sec fileSection) error {
	for _, l := range sec.head {
		if strings.HasPrefix(l, "rename from ") || strings.HasPrefix(l, "rename to ") ||
			strings.HasPrefix(l, "copy from ") || strings.HasPrefix(l, "copy to ") {
			return errors.New("该改动涉及重命名，逐块暂存会连路径一起改写；请整文件暂存")
		}
	}
	return nil
}

// splitDiffLines 拆行并去掉 split 产生的尾部空串。
//
// 尾部空串不是内容：留着会让 patch 末尾多一个空行，git apply 会把它
// 当成一个多余的行而报格式错误。
//
// 不做 CRLF 归一：git 的输出分隔符本来就是 \n，而内容行末尾的 \r 属于
// 文件内容（CRLF 文件）。统一替换会把 \r 从 patch 里抹掉，
// 结果是对 CRLF 文件的改动永远应用不上。
func splitDiffLines(diffText string) []string {
	if strings.TrimSpace(diffText) == "" {
		return nil
	}
	lines := strings.Split(diffText, "\n")
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// splitFileSections 按 `diff --git` 切成每文件一段。
//
// `git diff -- <path>` 里的 path 可以是目录，这时会带出多个文件；
// 分段之后才能确定目标 hunk 属于哪个文件头。
func splitFileSections(lines []string) []fileSection {
	var sections []fileSection
	var cur *fileSection

	for _, l := range lines {
		if strings.HasPrefix(l, "diff --git ") {
			if cur != nil {
				sections = append(sections, *cur)
			}
			cur = &fileSection{head: []string{l}}
			continue
		}
		if cur == nil {
			continue
		}
		// hunk 之前都是文件头。用 hunk 头当分界，避免把内容行误当成头。
		if _, isHunk := hunkRange(l); !isHunk && len(cur.lines) == 0 {
			cur.head = append(cur.head, l)
			continue
		}
		cur.lines = append(cur.lines, l)
	}
	if cur != nil {
		sections = append(sections, *cur)
	}
	return sections
}

// findHunkLines 返回区段里 header 区间部分匹配的那个 hunk（含 hunk 头），
// 找不到时返回 nil。
func findHunkLines(sec fileSection, target string) []string {
	for i, l := range sec.lines {
		rangePart, isHunk := hunkRange(l)
		if !isHunk || rangePart != target {
			continue
		}
		end := len(sec.lines)
		for j := i + 1; j < len(sec.lines); j++ {
			if _, next := hunkRange(sec.lines[j]); next {
				end = j
				break
			}
		}
		return sec.lines[i:end]
	}
	return nil
}

/* ------------------------------------------------------------------ */
/* 应用 patch                                                          */
/* ------------------------------------------------------------------ */

// applyPatch 用 `git apply --cached` 把 patch 写进（或从）index。
//
// Args:
//
//	reverse: true 反向应用，即把已暂存的那一块撤回工作区侧
//
// 从 stdin 传 patch 而不是先落成临时文件：临时文件要么写进仓库（污染
// 工作树与 status），要么写进系统临时目录（崩溃时留下垃圾）。
//
// `--unidiff-zero` 允许 0 行的 hunk：只删不增（或只增不删）的边界改动
// 会生成 `-N,0` 形式的块，不加这个选项 git 会直接拒绝整份 patch。
func applyPatch(dir, patch string, reverse bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), execTimeout)
	defer cancel()

	args := []string{"apply", "--cached", "--unidiff-zero"}
	if reverse {
		args = append(args, "--reverse")
	}
	args = append(args, "-")

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	noconsole.Hide(cmd)
	cmd.Stdin = strings.NewReader(patch)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("git apply 超时（%s）", execTimeout)
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("git apply --cached: %s", msg)
	}
	return nil
}
