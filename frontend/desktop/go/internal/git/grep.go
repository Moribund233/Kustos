package git

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/kustos/kustos-desktop/internal/platform/noconsole"
)

// 工作树全文搜索：调 `git grep`，不在本地另建索引。
//
// 为什么不是 SQLite FTS5 索引（设计文档的初始设想）：
//   - 索引必然有失效问题。桌面端刻意没有文件监听（见 implementation-status
//     的"不做文件监听"），一份"上次扫描时的索引"搜出来的内容会与工作树
//     悄悄脱节，而搜索结果的错误比搜索慢更致命——用户会拿旧行号去跳一个
//     已经不存在的定义。
//   - `.gitignore` 语义免费。git grep 天然只搜"被跟踪 + 未被忽略"的文件
//     （外加 --untracked 的新文件），自建索引要么重新实现一遍 ignore 规则，
//     要么把 node_modules 整坨吸进去。
//   - 与终端行为一致是本包的存在理由：git grep 的结果就是用户在终端里
//     能复现的结果。
//
// 代价是每次查询都扫一遍工作树。git grep 是 C 实现的，配合逐文件上限与
// 流式提前终止，真实仓库下这个代价在交互可接受的范围内。

// grepTimeout 是一次全文搜索的上限。
//
// 比一般本地命令（30s）更严：搜索是"打字即触发"的交互，转圈 30 秒的体验
// 等同于卡死；真要扫那么久的仓库，用户该缩短查询范围而不是干等。
const grepTimeout = 15 * time.Second

// grepPerFileLimit 是单个文件贡献的命中上限。
//
// 一个 lock 文件或生成文件能把整个结果配额吃光，让别的文件一条都进不来。
// 逐文件截断保证结果列表覆盖多个文件。
const grepPerFileLimit = 50

// defaultGrepLimit 是总命中的默认上限。
const defaultGrepLimit = 500

// ContentMatch 是一条全文命中。
type ContentMatch struct {
	// Path 是相对仓库根的路径（斜杠分隔）。
	Path string `json:"path"`
	// Line 是行号（1 起）。
	Line int `json:"line"`
	// Text 是该行内容（已去掉行尾换行）。
	Text string `json:"text"`
}

// GrepRequest 描述一次工作树全文搜索。
type GrepRequest struct {
	// Query 是查询文本；Regex 为真时按扩展正则解释，否则按字面量。
	Query string
	// Regex 为真时用 `-E`（扩展正则）而不是 `-F`（固定字符串）。
	Regex bool
	// CaseSensitive 为真时区分大小写；默认不区分——搜代码的人十次里
	// 九次记不准大小写，反过来"想区分"才是显式意图。
	CaseSensitive bool
	// Path 是可选的目录/文件前缀（相对仓库根、斜杠分隔），把搜索范围
	// 收窄到某个子树；空表示全仓库。
	Path string
	// MaxMatches 是总命中上限；<= 0 时用默认值。
	MaxMatches int
}

// GrepResult 是一次全文搜索的结果。
type GrepResult struct {
	// Matches 是按 git 输出顺序的命中（文件名字序、文件内行号序）。
	Matches []ContentMatch `json:"matches"`
	// Truncated 表示命中数触到了总上限、结果不完整。界面据此提示
	// "缩小查询范围"，而不是让用户以为整个仓库就只有这些。
	Truncated bool `json:"truncated"`
}

// GrepContent 在工作树里做全文搜索。
//
// Args:
//
//	dir: 仓库目录
//	req: 查询参数；Query 为空时返回空结果不报错
//
// Returns:
//
//	git 失败（非法正则、目录不可访问）时返回错误。"没有命中"是空结果，
//	不是错误——git 用退出码 1 表达它，与 grep 家族一致。
func GrepContent(dir string, req GrepRequest) (GrepResult, error) {
	abs, err := checkDir(dir)
	if err != nil {
		return GrepResult{}, err
	}
	if strings.TrimSpace(req.Query) == "" {
		// 空白查询返回空而不是报错：界面在用户还没输入时也会调用到这里，
		// 一次全仓库扫描（或 git 的"空模式匹配一切"）都不是想要的。
		return GrepResult{Matches: []ContentMatch{}}, nil
	}
	limit := req.MaxMatches
	if limit <= 0 {
		limit = defaultGrepLimit
	}

	args := []string{
		// -z：字段间以 NUL 分隔，路径与内容里的空格都不会造成歧义；
		// -n 给行号；-I 跳过二进制（对二进制文件报"命中"毫无意义，
		// 而它的一行可能是几 KB 的乱码）；--untracked 把"新增但还没
		// add"的文件也纳入——正在写代码的人最先搜的就是自己刚建的文件；
		// --no-color 关掉 ANSI 转义序列。
		"grep", "-z", "-n", "-I", "--no-color", "--untracked",
	}
	if req.Regex {
		args = append(args, "-E")
	} else {
		args = append(args, "-F")
	}
	if !req.CaseSensitive {
		args = append(args, "-i")
	}
	// 逐文件上限必须排在查询之前：git 规定选项不得出现在非选项参数之后。
	args = append(args, "-m", strconv.Itoa(grepPerFileLimit))
	// -e 显式标记查询起点：否则以 `-` 开头的查询会被当成选项解析。
	args = append(args, "-e", req.Query)
	if p := strings.TrimSpace(req.Path); p != "" {
		args = append(args, "--", filepath.ToSlash(p))
	}

	return runGrep(abs, args, limit)
}

// runGrep 启动进程并流式解析输出。
//
// 为什么流式而不是 execGit 的一口吞：一个宽泛的查询在仓库里可能命中
// 几万行，几百 MB 的输出先攒进内存再截断，等于把上限设在报错边缘。
// 流式读满配额就直接杀进程，多扫的部分根本不进内存。
func runGrep(dir string, args []string, limit int) (GrepResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), grepTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	noconsole.Hide(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return GrepResult{}, fmt.Errorf("启动 git grep 失败: %w", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return GrepResult{}, fmt.Errorf("启动 git grep 失败: %w", err)
	}

	matches := make([]ContentMatch, 0, min(limit, 128))
	truncated := false
	reader := bufio.NewReader(stdout)

reads:
	for {
		if len(matches) >= limit {
			// 满额即停：杀掉进程，剩下的输出不再有人读，git 会阻塞在
			// 写管道上，Kill 是最干脆的解法。
			truncated = true
			_ = cmd.Process.Kill()
			break reads
		}
		m, ok, rerr := readGrepRecord(reader)
		if rerr != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			// 超时杀进程时最后一条记录可能只写了一半：那不是"输出格式坏了"，
			// 报超时可操作，报截断只会让人怀疑 git。
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return GrepResult{}, fmt.Errorf("全文搜索超时（%s），请缩短查询或限定目录", grepTimeout)
			}
			return GrepResult{}, rerr
		}
		if !ok {
			break reads
		}
		matches = append(matches, m)
	}

	waitErr := cmd.Wait()
	if waitErr != nil {
		if truncated {
			// 我们自己杀的进程，退出状态无意义；截断已经说明结果不完整。
			return GrepResult{Matches: matches, Truncated: true}, nil
		}
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) && exitErr.ExitCode() == 1 {
			// grep 约定：1 = 没有命中。这是正常的空结果。
			return GrepResult{Matches: matches}, nil
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return GrepResult{}, fmt.Errorf("全文搜索超时（%s），请缩短查询或限定目录", grepTimeout)
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = waitErr.Error()
		}
		return GrepResult{}, fmt.Errorf("git grep: %s", msg)
	}
	return GrepResult{Matches: matches, Truncated: truncated}, nil
}

// readGrepRecord 读一条 `<path>\0<line>\0<text>\n` 记录。
//
// ok=false 表示输出到头（含进程被杀后管道关闭）。注意 `-z` 只把**前面的
// 字段**改成 NUL 分隔，命中行文本仍以换行结尾（实测格式：path\0line\0text\n）；
// 按"三个字段都用 NUL"来读会把下一条记录的路径并进上一条的文本里。
// 文本字段不含 NUL（含 NUL 的文件已被 -I 判为二进制跳过），读到换行即止。
// 半截的尾部记录（进程被杀时最后一条可能只写了一半）报错交由调用方处理。
func readGrepRecord(r *bufio.Reader) (ContentMatch, bool, error) {
	path, ok := readNULField(r)
	if !ok {
		return ContentMatch{}, false, nil
	}
	lineField, ok := readNULField(r)
	if !ok {
		return ContentMatch{}, false, fmt.Errorf("git grep 输出在路径后截断: %q", path)
	}
	text, sawLineEnd := readLineField(r)
	if !sawLineEnd && text == "" {
		return ContentMatch{}, false, fmt.Errorf("git grep 输出在行号后截断: %q", path)
	}
	lineNo, err := strconv.Atoi(strings.TrimSpace(lineField))
	if err != nil || lineNo < 1 {
		return ContentMatch{}, false, fmt.Errorf("git grep 行号不可解析: %q", lineField)
	}
	return ContentMatch{
		Path: filepath.ToSlash(path),
		Line: lineNo,
		// 末行没有换行的文件，git 输出同样不带行尾；CRLF 文件要裁掉 \r。
		Text: trimLineEnd(text),
	}, true, nil
}

// readNULField 读到下一个 NUL 为止；ok=false 表示没读完一个字段就到了尾。
func readNULField(r *bufio.Reader) (string, bool) {
	var buf []byte
	for {
		ch, err := r.ReadByte()
		if err != nil {
			return "", false
		}
		if ch == 0 {
			return string(buf), true
		}
		buf = append(buf, ch)
	}
}

// readLineField 读到下一个换行为止。
//
// 返回的字符串含行尾换行（交给 trimLineEnd 统一裁）；sawLineEnd=false
// 表示在遇到换行前就到了尾——末行无换行的文件会走到这里，此时若文本
// 非空仍是一条有效记录。
func readLineField(r *bufio.Reader) (string, bool) {
	var buf []byte
	for {
		ch, err := r.ReadByte()
		if err != nil {
			return string(buf), false
		}
		buf = append(buf, ch)
		if ch == '\n' {
			return string(buf), true
		}
	}
}

// trimLineEnd 去掉行尾的换行（LF 或 CRLF）。
func trimLineEnd(s string) string {
	return strings.TrimSuffix(strings.TrimSuffix(s, "\n"), "\r")
}
