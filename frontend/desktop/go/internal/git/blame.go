package git

import (
	"errors"
	"strconv"
	"strings"
)

// BlameLine 是某一行最后一次被改动的提交信息。
//
// Line 是**工作树侧**的行号：编辑器里摆着的那份文件才是用户看到的行序，
// 用 HEAD 侧的行号会让标记整体错位。
type BlameLine struct {
	// Line 是工作树侧行号，从 1 开始。
	Line int `json:"line"`
	// Commit 是提交哈希；工作树里未提交的行留空。
	Commit string `json:"commit"`
	// Author 是作者名；未提交的行留空。
	Author string `json:"author"`
	// Time 是提交时间，**毫秒**时间戳；未提交的行是 0。
	//
	// 用毫秒而不是 unix 秒：这个值要跨到 JS，前端 `new Date(ms)` 直接吃毫秒；
	// 秒与毫秒混用是本项目已经踩过的坑，跨越进程边界的时间一律毫秒。
	Time int64 `json:"time"`
	// Summary 是提交标题；未提交的行留空。
	Summary string `json:"summary"`
}

// Blame 返回文件每一行的归属提交。
//
// Args:
//
//	dir:  仓库目录
//	path: 相对仓库根的路径
//
// Returns:
//
//	按行号升序的归属列表；路径为空、不在仓库里时返回错误。
//
// 用 `--line-porcelain` 而不是 `--porcelain`：前者的每一行都带完整的作者与
// 时间头，解析时不必缓存"上一个提交块"，也就不会在输出被截断时错位。
// 输出行数多，但一次只 blame 一个文件，代价可以接受。
//
// 拿不到归属时返回空结果而不是错误：文件还没进 HEAD（刚新建、刚 add 未提交）
// 是编辑过程中的常态，让界面安静地不显示标记，比弹一个错误更好。
func Blame(dir, path string) ([]BlameLine, error) {
	abs, err := checkDir(dir)
	if err != nil {
		return nil, err
	}
	if path == "" {
		return nil, errors.New("路径为空")
	}

	// 未跟踪文件根本没有 HEAD 版本，问 git 只会得到 fatal。
	tracked, err := isTracked(abs, path)
	if err != nil || !tracked {
		return nil, nil
	}

	out, err := execGit(abs, "blame", "--line-porcelain", "--", path)
	if err != nil {
		// 已 add 但还没提交的文件也不在 HEAD 里，git 会报
		// "no such path ... in HEAD"。这类失败没有可展示的东西，
		// 与"未跟踪"同样处理：返回空结果。
		return nil, nil
	}
	return parseBlamePorcelain(out), nil
}

// parseBlamePorcelain 解析 `git blame --line-porcelain` 的输出。
//
// 一条记录由头行 `<sha> <原行号> <最终行号> [<行数>]` 开头，随后是若干
// `key value` 元信息行（author / author-time / summary 等），最后是
// TAB 开头的内容行。只取需要的四个字段，其余（mail、tz、committer…）忽略。
//
// 全 0 哈希表示这一行在工作树里被改过、还没有归属提交：此时元信息是
// "Not Committed Yet" 之类的占位文案，不能当真实作者展示，一律清空。
func parseBlamePorcelain(out string) []BlameLine {
	lines := make([]BlameLine, 0)
	cur := BlameLine{}

	for _, raw := range strings.Split(out, "\n") {
		// Windows 上 git 的子进程输出可能带 CRLF，留着 \r 会把
		// 提交标题和作者名多打一个不可见字符。
		line := strings.TrimSuffix(raw, "\r")

		if strings.HasPrefix(line, "\t") {
			appendBlame(&lines, cur)
			cur.Line++
			continue
		}

		if hash, finalLine, ok := parseBlameHeader(line); ok {
			cur = BlameLine{Line: finalLine, Commit: hash}
			continue
		}

		if v, ok := cutPrefix(line, "author "); ok {
			cur.Author = v
			continue
		}
		if v, ok := cutPrefix(line, "author-time "); ok {
			// author-time 是 unix 秒，对外换成毫秒。
			if sec, convErr := strconv.ParseInt(strings.TrimSpace(v), 10, 64); convErr == nil {
				cur.Time = sec * 1000
			}
			continue
		}
		if v, ok := cutPrefix(line, "summary "); ok {
			cur.Summary = v
		}
	}

	return lines
}

// appendBlame 收下一行，未提交的行把占位元信息清空。
func appendBlame(lines *[]BlameLine, cur BlameLine) {
	if isZeroHash(cur.Commit) {
		cur = BlameLine{Line: cur.Line}
	}
	*lines = append(*lines, cur)
}

// parseBlameHeader 识别并解析归属记录的头行。
//
// 必须校验首字段是纯十六进制哈希：内容行以外的元信息行里，
// `filename x.txt` 这类也可能被 strings.Fields 切成三段。
func parseBlameHeader(line string) (hash string, finalLine int, ok bool) {
	fields := strings.Fields(line)
	if len(fields) < 3 {
		return "", 0, false
	}
	hash = fields[0]
	if len(hash) != 40 && len(hash) != 64 {
		return "", 0, false
	}
	if strings.Trim(hash, "0123456789abcdef") != "" {
		return "", 0, false
	}
	n, err := strconv.Atoi(fields[2])
	if err != nil || n < 1 {
		return "", 0, false
	}
	return hash, n, true
}

// isZeroHash 判断是否是全 0 哈希（工作树里未提交的行）。
func isZeroHash(hash string) bool {
	return hash != "" && strings.Trim(hash, "0") == ""
}

// cutPrefix 去掉前缀并返回剩余部分。
func cutPrefix(s, prefix string) (string, bool) {
	if !strings.HasPrefix(s, prefix) {
		return "", false
	}
	return s[len(prefix):], true
}
