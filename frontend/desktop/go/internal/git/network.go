package git

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"strings"
	"time"

	"github.com/kustos/kustos-desktop/internal/platform/noconsole"
)

// 这个文件管"要联网的那几条 git 命令"：push、fetch，以及它们该不该带上
// 实例令牌。判断只有一条主线——**这条命令实际访问哪个远端**，凭据的作用域
// 与命令的参数都由它决定，所以执行、确认框文案、注入判定必须出自同一次
// 计算，否则用户看到的确认与实际发生的操作会分家。
//
// clone 不在这个文件里（见 clone.go）：它没有工作树可读，远端地址是刚拼
// 出来的，进程与超时也归调用方管。

// networkTimeout 是联网类 git 命令的上限。
//
// 比本地命令宽松得多：push/fetch 要走网络，自托管实例可能在 VPN 后面，
// 30 秒内没完成是常态而非故障。但也不能无限等——界面要能给出明确失败。
const networkTimeout = 3 * time.Minute

// execGitNetwork 与 execGit 相同，但用网络超时，并按 cred 决定是否注入凭据。
//
// cred 由调用方用 networkCredentials 算好：作用域到**这一条命令真正要访问的
// 那个远端**。拿不准就别传，让它回落到用户自己的 git 配置。
func execGitNetwork(dir string, cred *Credentials, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), networkTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = NetworkEnv(cred)
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

// pushPlan 是一条 push 的全部决策：跑什么、给用户看什么、碰哪个远端。
//
// 三者必须出自同一次计算。早期确认框与执行各算一遍，于是出现过
// "框里写着远端名、实际跑的是裸 git push" 这类对不上的情况——破坏性操作
// 的确认一旦不可信，整个闸门就白做了。
type pushPlan struct {
	// args 是交给 git 的参数（不含 "git"）。
	args []string
	// display 是给确认框看的完整命令。
	display string
	// remote 是这条命令真正要访问的远端名；凭据按它的作用域注入。
	remote string
	// createsUpstream 表示这条命令会顺手建立上游（带 --set-upstream）。
	createsUpstream bool
}

// PlanPush 决定一次 push 该怎么跑。
//
// Args:
//
//	dir:   仓库目录
//	force: 是否强制推送；用 `--force-with-lease` 而不是 `--force`，
//	       前者在远端已被别人更新时会拒绝，避免覆盖他人的提交
//
// 分支没有上游时不再把 git 那句 "no tracking information" 原样甩给用户：
// 终端里 git 会直接给出 `git push --set-upstream origin main`，桌面端就该
// 跑同一条命令——这正是"与终端行为一致"最常被撞到的一下。
//
// 但只在**能确定该推到哪**时才代做决定：拿不到当前分支名（游离 HEAD、
// 空仓库）或仓库根本没有远端时，退回裸 `git push`，让 git 自己报错。
// 猜一个远端名或分支名去 push，可能把提交落到一个用户没打算碰的分支上。
func PlanPush(dir string, force bool) pushPlan {
	abs, err := checkDir(dir)
	if err != nil {
		return plainPushPlan(force)
	}

	remote, upstreamBranch := upstreamInfo(abs)
	parts := []string{"push"}
	if force {
		parts = append(parts, "--force-with-lease")
	}

	if remote != "" && upstreamBranch != "" {
		parts = append(parts, remote, upstreamBranch)
		return pushPlan{
			args:    parts,
			display: "git " + strings.Join(parts, " "),
			remote:  remote,
		}
	}

	branch, branchErr := currentBranch(abs)
	if branchErr != nil || branch == "" || branch == "HEAD" {
		return plainPushPlan(force)
	}
	name := pushDefaultRemote(abs, branch)
	if name == "" {
		return plainPushPlan(force)
	}

	parts = append(parts, "--set-upstream", name, branch)
	return pushPlan{
		args:            parts,
		display:         "git " + strings.Join(parts, " "),
		remote:          name,
		createsUpstream: true,
	}
}

// plainPushPlan 是不加任何远端与分支的通用形式。
//
// 确认框里宁可看到一句朴素的 `git push`，也不要空白——空白比"不知道细节"更糟。
func plainPushPlan(force bool) pushPlan {
	parts := []string{"push"}
	if force {
		parts = append(parts, "--force-with-lease")
	}
	return pushPlan{args: parts, display: "git " + strings.Join(parts, " ")}
}

// pushDefaultRemote 返回分支没有上游时该推到哪个远端。
//
// 依次读用户自己的配置，最后才轮到 origin：有人把正主远端叫 `upstream`
// 而不是 `origin`，替他写死 origin 会把提交推到一个他没打算碰的地方。
//
// 顺序与 git 一致：`branch.<name>.pushremote` → `remote.pushdefault` →
// origin → 第一个远端；一个都没有时返回空串。配置里写了一个已经不存在的
// 远端时忽略它——照用只会换来一句 "no such remote"，用户根本不知道这条
// 建议是从哪来的。
func pushDefaultRemote(dir string, branch string) string {
	names := remoteNames(dir)
	if len(names) == 0 {
		return ""
	}
	matches := func(name string) bool {
		for _, got := range names {
			if got == name {
				return true
			}
		}
		return false
	}

	if branch != "" {
		if name := gitConfigValue(dir, "branch."+branch+".pushremote"); name != "" && matches(name) {
			return name
		}
	}
	if name := gitConfigValue(dir, "remote.pushdefault"); name != "" && matches(name) {
		return name
	}
	for _, name := range names {
		if name == "origin" {
			return name
		}
	}
	return names[0]
}

// gitConfigValue 读一条 git 配置；读不到返回空串。
func gitConfigValue(dir, key string) string {
	out, err := execGit(dir, "config", "--get", key)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// hasRemote 判断指定远端是否存在。
func hasRemote(dir, name string) bool {
	for _, got := range remoteNames(dir) {
		if got == name {
			return true
		}
	}
	return false
}

// PushCommand 返回将要执行的 push 命令，供确认框展示。
//
// 破坏性操作必须让用户看到**完整命令**再确认——"确认强制推送？"这种问法
// 无法让人判断后果，而 `git push --force-with-lease origin main` 能。
// 首次推送带 --set-upstream 也如实写在这里：用户看到的那条就是真跑的那条。
func PushCommand(dir string, force bool) string {
	return PlanPush(dir, force).display
}

// Push 把当前分支推送到上游。
//
// Args:
//
//	dir:   仓库目录
//	force: 是否强制推送；用 `--force-with-lease` 而不是 `--force`，
//	       前者在远端已被别人更新时会拒绝，避免覆盖他人的提交
//	auth:  当前实例的凭据；nil、令牌为空，或这条命令要访问的远端不属于
//	       本实例时不注入，沿用用户自己的 credential helper / SSH agent
//
// Returns:
//
//	没有远端、没有提交、凭证缺失或被远端拒绝时返回可读错误。
//
// 桌面端不接触也不存储远端密码。对**本实例**的仓库有个例外：令牌只进这一次
// 进程的 `GIT_CONFIG_*` 环境，作用域收到这条命令真正访问的那个远端。裸机
// 第一次 push 会弹凭据窗或直接失败，而用引导克隆仓库的用户从没配过任何东西，
// 这个坑是桌面端自己挖的。
func Push(dir string, force bool, auth *InstanceAuth) error {
	abs, err := checkDir(dir)
	if err != nil {
		return err
	}
	plan := PlanPush(abs, force)
	_, err = execGitNetwork(abs, networkCredentials(abs, plan.remote, auth), plan.args...)
	return err
}

// Fetch 从远端拉取引用（不改工作区）。
//
// auth 的含义与 Push 一致：只给属于本实例的那个远端注入令牌。
func Fetch(dir string, auth *InstanceAuth) error {
	abs, err := checkDir(dir)
	if err != nil {
		return err
	}
	name := fetchRemoteName(abs)
	_, err = execGitNetwork(abs, networkCredentials(abs, name, auth), "fetch", "--prune")
	return err
}

// fetchRemoteName 返回 `git fetch` 这次会访问哪个远端。
//
// 裸 `git fetch`（不带远端名）按 git 的规则取当前分支的上游远端，
// 没有上游则取 origin。名字要和实际请求对上，否则令牌注入的作用域键
// 匹配不到，表现为"配了没生效"。
func fetchRemoteName(dir string) string {
	if remote, _ := upstreamInfo(dir); remote != "" && hasRemote(dir, remote) {
		return remote
	}
	names := remoteNames(dir)
	for _, name := range names {
		if name == "origin" {
			return name
		}
	}
	if len(names) > 0 {
		return names[0]
	}
	return ""
}

// InstanceAuth 是"此刻登录着哪个实例"，联网命令据此决定要不要注入令牌。
//
// 它由装配层从会话服务现取，不缓存：一次 push 之前令牌可能已经换了。
// Token 为空表示未登录或已失效，此时联网命令一律沿用用户自己的 git 配置。
//
// 不记用户名：服务端 git-auth 的 Bearer 分支只验令牌，用户名填什么都不影响
// 结果，多存一个字段只会让"凭据该带什么"这件事看起来比实际复杂。
type InstanceAuth struct {
	// BaseURL 是实例地址，如 https://git.example.com 或 https://example.com/git。
	BaseURL string
	// Token 是 access token，以 Bearer 形式交给 git。
	Token string
}

// NetworkEnv 组装联网 git 命令（push / fetch）的进程环境。
//
// 与 cloneEnv 共用同一条安全边界与同一份拼装实现：
//   - 令牌只活在 `GIT_CONFIG_*` 环境变量里，等价于 `-c` 但不上命令行；
//   - 作用域收到**完整仓库地址**而不是主机：重定向与子模块可能把请求带向
//     第三方地址，按主机散令牌等于把令牌交给陌生人；
//   - `credential.helper=` 清空：桌面端没有终端，全局 helper（GCM、
//     osxkeychain）在 401 时弹窗或挂死，用户只会看到"点了没反应"。
//
// cred 为 nil（外部远端、未登录）时不注入任何认证配置，但仍关掉终端提示：
// GUI 里没有终端可输入密码，挂在那里是最坏的可观察行为；用户自己的 helper
// 与 SSH agent 不受影响，外部远端照旧走那条链路。
func NetworkEnv(cred *Credentials) []string {
	if cred != nil {
		return cloneEnv(cred)
	}
	return append(gitEnv(), "GIT_TERMINAL_PROMPT=0")
}

// remoteMatchesInstance 判断远端地址是否指向本实例仓库集合里的一份。
//
// 判据是**仓库路径**而不是主机名：按主机匹配会把同主机上的其他仓库（别人的
// fork、与实例共存的 gitea、前缀同名的那个 repo）一起当成自己人注入令牌；
// 反过来，实例挂在子路径 `https://example.com/git` 上时按主机匹配又会漏判。
//
// 只认带 scheme 的 http/https：ssh（`git@host:path`）、file 与本地路径回落在
// 用户自己的凭据体系里，Bearer 令牌对它们本来就不适用；带 userinfo 的远端
// 一律拒绝——那说明有人把凭据写进了地址，不该再叠一层我们的令牌。
//
// Args:
//
//	remoteURL: 工作副本某个远端的原始地址（`git remote get-url` 的输出）
//	baseURL:   实例地址
//
// Returns:
//
//	匹配时给出该仓库在实例上的 owner/repo（不含 .git 后缀）；
//	不匹配、形状不合法或空串时返回 false 与空路径。
func remoteMatchesInstance(remoteURL, baseURL string) (bool, string) {
	remote, err := url.Parse(strings.TrimSpace(remoteURL))
	if err != nil || !httpEndpoint(remote) || remote.User != nil {
		return false, ""
	}
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || !httpEndpoint(base) {
		return false, ""
	}

	if !strings.EqualFold(remote.Scheme, base.Scheme) ||
		!strings.EqualFold(remote.Host, base.Host) {
		return false, ""
	}

	prefix := strings.TrimRight(base.Path, "/")
	path := remote.Path
	switch {
	case prefix == "":
		// 实例挂在根上：任何两段路径都属于它的仓库命名空间。
	case path == prefix || !strings.HasPrefix(path, prefix+"/"):
		// 边界必须落在 "/" 上，否则 /git 会匹配到 /git-fastlab/repo。
		return false, ""
	default:
		path = path[len(prefix):]
	}

	slug, ok := repoSlugFromRemotePath(path)
	if !ok {
		return false, ""
	}
	return true, slug
}

// httpEndpoint 判断解析出来的地址是否是可用的 http/https 端点。
func httpEndpoint(u *url.URL) bool {
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	return u.Host != ""
}

// networkCredentials 决定这一条联网命令该不该带上实例令牌。
//
// remoteName 是这条命令**真正要访问的远端**：push 用解析出的远端，fetch 用
// origin。作用域取 `git remote get-url` 的原样输出而不是拼接出来的克隆地址——
// 用户可能 set-url 改写过写法（带不带 .git、大小写、端口），只有原样输出与
// git 实际发出的请求对得上。
//
// clone 不复用这里：目标目录还不存在，读不到任何远端，作用域只能用刚拼出来
// 的那个地址（见 services.WorkingCopyService.cloneRequest）。
//
// auth 为 nil、令牌为空、远端缺失或不属于本实例时返回 nil——不注入。
func networkCredentials(dir, remoteName string, auth *InstanceAuth) *Credentials {
	if auth == nil || remoteName == "" {
		return nil
	}
	if strings.TrimSpace(auth.Token) == "" || strings.TrimSpace(auth.BaseURL) == "" {
		return nil
	}
	remoteURL := RemoteURL(dir, remoteName)
	if remoteURL == "" {
		return nil
	}
	ok, _ := remoteMatchesInstance(remoteURL, auth.BaseURL)
	if !ok {
		return nil
	}
	return &Credentials{Token: strings.TrimSpace(auth.Token), URL: remoteURL}
}

// repoSlugFromRemotePath 把前缀之后的剩余路径收成 owner/repo。
//
// 容忍 git 常见的几种写法：`/alice/notes.git`、`/alice/notes`，以及手滑粘了
// 完整访问地址时的路由尾巴（`/info/refs` 之类；查询串在 url.Parse 里已分离）。
//
// 要求恰好两段：owner 与 repo 都非空且不是 "." ".."。多于两段判不匹配——
// 深层路径不属于这个实例的仓库命名空间。
func repoSlugFromRemotePath(path string) (string, bool) {
	for _, suffix := range []string{"/info/refs", "/git-upload-pack", "/git-receive-pack"} {
		if strings.HasSuffix(path, suffix) {
			path = strings.TrimSuffix(path, suffix)
			break
		}
	}
	path = strings.Trim(path, "/")
	if len(path) >= 4 && strings.EqualFold(path[len(path)-4:], ".git") {
		path = path[:len(path)-4]
	}
	if path == "" {
		return "", false
	}
	segs := strings.Split(path, "/")
	if len(segs) != 2 {
		return "", false
	}
	for _, seg := range segs {
		if seg == "" || seg == "." || seg == ".." {
			return "", false
		}
	}
	return segs[0] + "/" + segs[1], true
}
