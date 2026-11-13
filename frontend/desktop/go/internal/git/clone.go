package git

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/kustos/kustos-desktop/internal/platform/noconsole"
)

// ErrTargetExists 表示克隆目标路径已经被占用。
//
// 单独成哨兵错误是为了让界面能说清"这个目录已经有了"，而不是把 git 的
// "destination path already exists" 原样丢给用户。
var ErrTargetExists = errors.New("目标目录已存在")

// ClonePhase 是克隆进度所处的阶段。
type ClonePhase string

const (
	// ClonePhaseStarting 表示 git 已经启动、正在连远端。
	ClonePhaseStarting ClonePhase = "starting"
	// ClonePhaseCounting 表示远端在统计要传多少对象。
	ClonePhaseCounting ClonePhase = "counting"
	// ClonePhaseCompressing 表示远端在压缩对象。
	ClonePhaseCompressing ClonePhase = "compressing"
	// ClonePhaseReceiving 表示正在下载对象，这是耗时最长的一段。
	ClonePhaseReceiving ClonePhase = "receiving"
	// ClonePhaseResolving 表示正在解析增量。
	ClonePhaseResolving ClonePhase = "resolving"
	// ClonePhaseCheckout 表示正在落盘、检出工作区。
	ClonePhaseCheckout ClonePhase = "checkout"
)

// CloneProgress 是一次进度回报。
type CloneProgress struct {
	// Phase 是当前阶段。
	Phase ClonePhase `json:"phase"`
	// Percent 是当前阶段的完成百分比；-1 表示这个阶段没有百分比。
	Percent int `json:"percent"`
}

// Credentials 是交给 git 的出站凭据。
//
// 它只活在这一次 git 进程的环境里：不写 config、不拼 URL、不落磁盘。
// 拼进 URL 会让它出现在 .git/config 的 origin 地址里，之后任何能读仓库目录的
// 进程都能把令牌抄走；写进 config 同样会留下来。这里用 `GIT_CONFIG_*` 环境
// 变量把 `http.<URL>.extraHeader` 临时塞给 git 进程，进程退出即消失。
type Credentials struct {
	// Token 是访问令牌，以 `Authorization: Bearer` 形式发送。
	//
	// 为什么不走 Basic（用户名 + 令牌当密码）：Kustos 的 git-auth 在 Basic
	// 分支校验的是**账号密码**（`verify_password`），令牌填进去必然 401；
	// git 收到 401 后会转去找 credential helper，在桌面端没有终端可交互的
	// 环境里就是"点了克隆，进度条永远停着"。实测两种方式都验过：Bearer 通过，
	// Basic 用令牌不通过。
	Token string
	// URL 是这组凭据唯一适用的远端地址。
	//
	// 作用域收到具体仓库而不是主机：一次克隆可能牵出第三方地址（重定向、
	// 子模块），按主机散令牌等于把它交给陌生人。
	URL string
}

// CloneRequest 描述一次克隆。
type CloneRequest struct {
	// URL 是远端地址，**不得含密码**。
	URL string
	// Dir 是目标目录的绝对路径；必须不存在。
	Dir string
	// Branch 为空时用远端默认分支。
	Branch string
}

// Clone 把远端仓库克隆到本地目录。
//
// 为什么不用 execGitNetwork：clone 的耗时与仓库大小成正比，3 分钟的上限对
// 真实仓库不够用，而"等到超时再报错"对用户毫无价值——他需要的是看得见的
// 进度和随时能按的取消。因此这里自己管进程与 context，由调用方决定何时取消。
//
// Args:
//
//	ctx:        取消即杀进程；返回后只删本地新建的那个目录
//	req:        远端地址与目标目录
//	cred:       出站凭据；nil 表示沿用用户自己的 git 配置（SSH agent、全局 helper）
//	onProgress: 进度回调；可为 nil
//
// Returns:
//
//	目标目录已存在返回 ErrTargetExists；git 失败时返回带 git 原文的错误；
//	ctx 被取消时返回 context.Canceled，且不会留下半成品目录。
func Clone(ctx context.Context, req CloneRequest, cred *Credentials, onProgress func(CloneProgress)) error {
	target, err := cloneTarget(req.Dir)
	if err != nil {
		return err
	}

	args := []string{"-c", "core.quotepath=false"}
	if cred != nil {
		// 先清空已有的 helper：用户机器上的全局 helper（Git Credential Manager、
		// osxkeychain 等）在收到 401 时会弹窗或读钥匙串，而此刻它拿不到任何
		// 有用信息，只会把一次注定失败的克隆变成一次可疑的弹窗。
		args = append(args, "-c", "credential.helper=")
	}
	args = append(args, "clone", "--progress")
	if strings.TrimSpace(req.Branch) != "" {
		args = append(args, "--branch", strings.TrimSpace(req.Branch))
	}
	// `--` 之后是纯位置参数：远端地址与目录都不再被当成选项解析。
	args = append(args, "--", req.URL, target)

	cmd := exec.CommandContext(ctx, "git", args...)
	// Dir 取父目录：目标目录还不存在，把它设成 cmd.Dir 会让进程直接起不来。
	cmd.Dir = filepath.Dir(target)
	cmd.Env = cloneEnv(cred)
	noconsole.Hide(cmd)

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("读取 git 输出失败: %w", err)
	}
	var stdout bytes.Buffer
	cmd.Stdout = &stdout

	if err := cmd.Start(); err != nil {
		// 启动失败时目标目录还没被建出来，无需清理。
		return wrapCloneStartError(err)
	}

	// git 的失败原因写在 stderr 的一堆进度行之间，进度行会被 \r 原地覆盖，
	// 所以边读边把非进度行留起来，失败时用最后一条作为错误说明。
	var reasons []string
	done := make(chan struct{})
	go func() {
		defer close(done)
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		scanner.Split(splitProgress)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			if p, ok := parseCloneProgress(line); ok {
				if onProgress != nil {
					onProgress(p)
				}
				continue
			}
			reasons = append(reasons, line)
			if len(reasons) > 8 {
				reasons = reasons[1:]
			}
		}
	}()

	<-done
	waitErr := cmd.Wait()

	if ctxErr := ctx.Err(); ctxErr != nil {
		// 取消：只删我们自己刚建出来的目录。目标路径在进来时已确认不存在，
		// 所以这里不会误删用户已有的东西。
		removeClonedTarget(target)
		return ctxErr
	}
	if waitErr != nil {
		removeClonedTarget(target)
		return cloneFailure(waitErr, reasons)
	}
	return nil
}

// cloneTarget 校验目标路径并保证父目录存在。
func cloneTarget(dir string) (string, error) {
	if strings.TrimSpace(dir) == "" {
		return "", errors.New("目标目录为空")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("解析路径失败: %w", err)
	}
	if _, err := os.Lstat(abs); err == nil {
		return "", ErrTargetExists
	} else if !os.IsNotExist(err) {
		return "", permissionError(filepath.Dir(abs), err)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", permissionError(filepath.Dir(abs), err)
	}
	return abs, nil
}

// permissionError 把"权限不足"翻译成用户能照着做的一句话。
//
// 原始的系统错误是 `mkdir C:\Users\x\Kustos: Access is denied.`——它说出了
// 哪条系统调用失败，却没说用户该怎么办，而且经过绑定层还会被套上
// `RuntimeError:` 前缀。权限不足时唯一有用的信息是"换一个位置"，所以这里
// 直接把可操作的指示写进错误里。
func permissionError(dir string, err error) error {
	if errors.Is(err, os.ErrPermission) || isWindowsAccessDenied(err) {
		return fmt.Errorf("没有权限在 %s 下创建目录，请换一个位置（例如另一个磁盘上的目录）", dir)
	}
	return fmt.Errorf("创建目录失败: %s: %w", dir, err)
}

// removeClonedTarget 清掉克隆失败的半成品目录。
//
// 失败的克隆会留下一个只含 .git 的目录，既不是可用仓库又占着路径，
// 用户下次再试会被 ErrTargetExists 挡住——所以必须在失败路径上删掉。
func removeClonedTarget(target string) {
	_ = os.RemoveAll(target)
}

// wrapCloneStartError 把"根本没跑起来 git"翻译成可操作的话。
func wrapCloneStartError(err error) error {
	if errors.Is(err, exec.ErrNotFound) {
		return ErrGitMissing
	}
	return fmt.Errorf("启动 git 失败: %w", err)
}

// cloneFailure 把 git 的 stderr 收尾行拼成一条错误。
func cloneFailure(err error, reasons []string) error {
	if len(reasons) == 0 {
		return fmt.Errorf("git clone 失败: %w", err)
	}
	// 取最后一行：git 的结论（fatal: / error:）总在最后。
	return errors.New(strings.TrimSpace(reasons[len(reasons)-1]))
}

// credentialScript 已废弃：凭据改走 `GIT_CONFIG_*` 环境变量（见 cloneEnv），
// 不再需要 sh 内联 helper。保留这段说明是为了让后来者知道为什么没有它了。

// cloneEnv 组装 git 出站进程的环境。
//
// 凭据通过 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`
// 注入到**这一个进程**里，等价于命令行上的 `-c key=value`，但不出现在
// 进程命令行（本机其他进程能读 /proc 的 cmdline）、不落 .git/config。
//
// 两件事一起做：
//  1. `credential.helper=` 清空 —— 用户机器上的全局 helper（Git Credential
//     Manager、osxkeychain 等）在 401 时可能弹窗或读钥匙串；桌面端没有终端，
//     弹出来的窗口既解释不清也没法用。
//  2. `http.<完整仓库地址>.extraHeader=Authorization: Bearer <token>` ——
//     作用域收到具体仓库，而不是主机：一次克隆可能牵出第三方地址（重定向、
//     子模块），按主机散令牌等于把它交给陌生人。
//
// GIT_TERMINAL_PROMPT=0：桌面端没有终端可交互，让 git 在缺凭据时立刻失败，
// 而不是挂在那里等一个永远不会有人输入的密码。这正是 GUI 里"点了克隆就
// 再也不动了"的成因。
func cloneEnv(cred *Credentials) []string {
	env := make([]string, 0, 24)
	for _, kv := range gitEnv() {
		// 丢掉 gitEnv 自带的 GIT_CONFIG_* 三件套：下面按数量重新拼。留着会
		// 出现两份 GIT_CONFIG_COUNT，哪份生效取决于进程环境的去重规则。
		if strings.HasPrefix(kv, "GIT_CONFIG_COUNT=") ||
			strings.HasPrefix(kv, "GIT_CONFIG_KEY_") ||
			strings.HasPrefix(kv, "GIT_CONFIG_VALUE_") {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "GIT_TERMINAL_PROMPT=0")

	pairs := []string{"core.quotepath", "false"}
	if cred != nil && strings.TrimSpace(cred.Token) != "" && strings.TrimSpace(cred.URL) != "" {
		pairs = append(pairs,
			"credential.helper", "",
			"http."+strings.TrimSpace(cred.URL)+".extraHeader", "Authorization: Bearer "+cred.Token,
		)
	}
	return append(env, gitConfigEnv(pairs...)...)
}

// gitConfigEnv 把若干组成对的 key/value 摊成 git 认识的 GIT_CONFIG_* 变量。
func gitConfigEnv(pairs ...string) []string {
	n := len(pairs) / 2
	out := make([]string, 0, 1+3*n)
	out = append(out, "GIT_CONFIG_COUNT="+strconv.Itoa(n))
	for i := 0; i < n; i++ {
		suffix := strconv.Itoa(i)
		out = append(out,
			"GIT_CONFIG_KEY_"+suffix+"="+pairs[2*i],
			"GIT_CONFIG_VALUE_"+suffix+"="+pairs[2*i+1],
		)
	}
	return out
}

// splitProgress 按 \n 或 \r 切分 git 的进度输出。
//
// `--progress` 在不是终端时也会输出，但用的是 `\r` 原地刷新同一行；
// 只按 \n 切会得到一条长达整个下载过程的行，百分比就永远停在最后一次。
func splitProgress(data []byte, atEOF bool) (int, []byte, error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	for i, b := range data {
		if b == '\n' || b == '\r' {
			return i + 1, data[:i], nil
		}
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// progressPercent 从一行进度里抠出百分比。
var progressPercent = regexp.MustCompile(`(\d{1,3})%`)

// parseCloneProgress 把一行 stderr 解析成进度。
//
// 返回 false 表示这行不是进度（例如 "fatal: ..."），调用方应当把它当错误文本留下。
//
// 不同 git 版本的措辞不完全一致（"Updating files" 在旧版本里是
// "Checking out files"），因此按关键字匹配而不是全等。
func parseCloneProgress(line string) (CloneProgress, bool) {
	phase, ok := clonePhaseOf(line)
	if !ok {
		return CloneProgress{}, false
	}
	percent := -1
	if m := progressPercent.FindStringSubmatch(line); m != nil {
		if v, err := strconv.Atoi(m[1]); err == nil && v >= 0 && v <= 100 {
			percent = v
		}
	}
	return CloneProgress{Phase: phase, Percent: percent}, true
}

// clonePhaseOf 判断一行属于哪个阶段。
func clonePhaseOf(line string) (ClonePhase, bool) {
	switch {
	case strings.Contains(line, "Cloning into"):
		return ClonePhaseStarting, true
	case strings.Contains(line, "Counting objects"):
		return ClonePhaseCounting, true
	case strings.Contains(line, "Compressing objects"):
		return ClonePhaseCompressing, true
	case strings.Contains(line, "Receiving objects"):
		return ClonePhaseReceiving, true
	case strings.Contains(line, "Resolving deltas"):
		return ClonePhaseResolving, true
	case strings.Contains(line, "Updating files"), strings.Contains(line, "Checking out files"):
		return ClonePhaseCheckout, true
	default:
		return "", false
	}
}

/* ------------------------------------------------------------------ */
/* 地址构造与校验                                                       */
/* ------------------------------------------------------------------ */

// repoPathPattern 是服务端仓库路径（owner/repo）的形状。
var repoPathPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`)

// InstanceCloneURL 把实例地址与仓库路径拼成 HTTPS 克隆地址。
//
// 为什么在 Go 侧拼而不是前端：地址拼接是"能拼出什么就能让 git 去访问什么"
// 的事，让它只发生在一个地方，校验才可能完整。前端只传 owner/repo，
// 拼错了也不可能拼出一个指向别处的地址。
//
// 服务端不返回 clone_url（响应体里根本没这个字段），但网关把
// `/{owner}/{repo}.git` 直接交给了 git-http-backend，所以规则是确定的。
//
// Args:
//
//	base:     实例地址，如 https://git.example.com
//	repoPath: owner/repo，不含 .git 后缀
//
// Returns:
//
//	克隆地址；形状不合法时返回错误，绝不"尽力拼一个"。
func InstanceCloneURL(base, repoPath string) (string, error) {
	trimmed := strings.TrimSpace(repoPath)
	if !repoPathPattern.MatchString(trimmed) {
		return "", fmt.Errorf("仓库路径不合法: %q", trimmed)
	}
	// ".." 也满足字符集，但那是往上跳一层，不是仓库名。
	for _, seg := range strings.Split(trimmed, "/") {
		if seg == "." || seg == ".." {
			return "", fmt.Errorf("仓库路径不合法: %q", trimmed)
		}
	}
	// 后端返回的 path 不带 .git 后缀；真带上说明调用方传错了层，
	// 直接拼会得到 "notes.git.git"。
	if strings.HasSuffix(strings.ToLower(trimmed), ".git") {
		return "", fmt.Errorf("仓库路径不该带 .git 后缀: %q", trimmed)
	}

	parsed, err := url.Parse(strings.TrimSpace(base))
	if err != nil {
		return "", fmt.Errorf("实例地址不合法: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("实例地址必须用 http 或 https: %q", base)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("实例地址缺少主机: %q", base)
	}
	return strings.TrimRight(parsed.String(), "/") + "/" + trimmed + ".git", nil
}

// ValidateRemoteURL 检查用户手输的远端地址。
//
// 只挡两类必然会出事、而用户自己看不出来的输入：
//   - 带密码的地址：那个密码会被 git 原样写进 .git/config 的 origin 里；
//   - 含空白的地址：多半是从别处粘错了。
//
// 其余交给 git 自己判断——支持哪些协议（ssh、file、http）是 git 的事，
// 在这里限死只会挡住合法的本地路径克隆。
func ValidateRemoteURL(raw string) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return errors.New("远端地址为空")
	}
	if strings.ContainsAny(trimmed, " \t\n\r") {
		return errors.New("远端地址不能包含空白字符")
	}
	// scp 风格（git@host:path）不是合法 URL，url.Parse 会直接报错，
	// 而它是 SSH 最常用的写法，必须先认出来。
	if isSCPStyle(trimmed) {
		return validateSCPStyle(trimmed)
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return fmt.Errorf("远端地址不合法: %w", err)
	}
	if parsed.User != nil {
		if _, hasPassword := parsed.User.Password(); hasPassword {
			return errors.New("远端地址里不要带密码：那会被写进 .git/config")
		}
	}
	return nil
}

// isSCPStyle 判断是否为 scp 风格的 SSH 地址。
//
// 判据：没有 "://"，且冒号出现在第一个斜杠之前。`C:\path` 这类 Windows
// 路径也含冒号但冒号在盘符位置且带反斜杠，因此额外要求不是单个字母开头。
func isSCPStyle(raw string) bool {
	if strings.Contains(raw, "://") {
		return false
	}
	colon := strings.Index(raw, ":")
	if colon <= 0 {
		return false
	}
	slash := strings.IndexAny(raw, "/\\")
	if slash >= 0 && slash < colon {
		return false
	}
	// 单字母盘符（C:/x）不是 SSH 地址。
	if colon == 1 {
		return false
	}
	// `user@host:path` 里冒号前应当有 '@'。
	head := raw[:colon]
	return strings.Contains(head, "@") || !strings.Contains(head, ":")
}

// validateSCPStyle 检查 scp 风格地址里是否夹带了密码。
func validateSCPStyle(raw string) error {
	at := strings.LastIndex(raw, "@")
	colon := strings.Index(raw, ":")
	if at < 0 || at > colon {
		return nil
	}
	// `user:password@host:path` —— 用户名段里有冒号即视为夹带密码。
	if strings.Contains(raw[:at], ":") {
		return errors.New("远端地址里不要带密码：那会被写进 .git/config")
	}
	return nil
}

// CredentialsHost 从克隆地址里取出凭据点（主机名，不含端口）。
//
// 取主机名而不是带端口的主机，是因为 git 传给 helper 的 host 字段本身不带
// 端口——helper 若拿带端口的值去比，永远匹配不上，表现为"令牌没用上"。
func CredentialsHost(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}
