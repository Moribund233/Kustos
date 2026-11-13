package git

import (
	"path/filepath"
	"strings"
	"testing"
)

/* ------------------------------------------------------------------ */
/* 远端归属判定（纯函数，不碰进程）                                      */
/* ------------------------------------------------------------------ */

func TestRemoteMatchesInstance(t *testing.T) {
	cases := []struct {
		name     string
		remote   string
		base     string
		wantOK   bool
		wantSlug string
	}{
		{
			name:   "标准克隆地址",
			remote: "https://git.example.com/alice/notes.git",
			base:   "https://git.example.com",
			wantOK: true, wantSlug: "alice/notes",
		},
		{
			name:   "没有 .git 后缀",
			remote: "https://git.example.com/alice/notes",
			base:   "https://git.example.com",
			wantOK: true, wantSlug: "alice/notes",
		},
		{
			name:   "实例地址带尾斜杠",
			remote: "https://git.example.com/alice/notes.git",
			base:   "https://git.example.com/",
			wantOK: true, wantSlug: "alice/notes",
		},
		{
			name:   "主机与 scheme 大小写不敏感",
			remote: "HTTPS://Git.Example.COM/alice/notes.git",
			base:   "https://git.example.com",
			wantOK: true, wantSlug: "alice/notes",
		},
		{
			name:   "带端口要一致",
			remote: "https://git.example.com:8443/alice/notes.git",
			base:   "https://git.example.com:8443",
			wantOK: true, wantSlug: "alice/notes",
		},
		{
			name:   "端口不同就不算同一台",
			remote: "https://git.example.com:8443/alice/notes.git",
			base:   "https://git.example.com",
			wantOK: false,
		},
		{
			name:   "实例挂在子路径下",
			remote: "https://example.com/git/alice/notes.git",
			base:   "https://example.com/git",
			wantOK: true, wantSlug: "alice/notes",
		},
		{
			name:   "子路径实例要带完整前缀",
			remote: "https://example.com/alice/notes.git",
			base:   "https://example.com/git",
			wantOK: false,
		},
		{
			// 前缀边界必须落在 "/" 上：按主机或按字符串前缀匹配都会把
			// 同主机上的别的东西认成自己人。
			name:   "前缀同名但不是仓库命名空间",
			remote: "https://example.com/git-fastlab/notes.git",
			base:   "https://example.com/git",
			wantOK: false,
		},
		{
			name:   "同主机上的第三方仓库",
			remote: "https://git.example.com/other-org/tool.git",
			base:   "https://git.example.com",
			wantOK: true, wantSlug: "other-org/tool",
		},
		{
			name:   "别的主机绝不匹配",
			remote: "https://github.com/alice/notes.git",
			base:   "https://git.example.com",
			wantOK: false,
		},
		{
			// ssh 写法由用户自己的 agent 管，Bearer 对它本来就不适用。
			name:   "scp 形式的 ssh",
			remote: "git@git.example.com:alice/notes.git",
			base:   "https://git.example.com",
			wantOK: false,
		},
		{
			name:   "ssh scheme",
			remote: "ssh://git@git.example.com/alice/notes.git",
			base:   "https://git.example.com",
			wantOK: false,
		},
		{
			name:   "http 与 https 不算同一台",
			remote: "http://git.example.com/alice/notes.git",
			base:   "https://git.example.com",
			wantOK: false,
		},
		{
			// 地址里带凭据说明有人把令牌写进了 origin，不该再叠一层。
			name:   "带 userinfo 的远端",
			remote: "https://alice@git.example.com/alice/notes.git",
			base:   "https://git.example.com",
			wantOK: false,
		},
		{
			name:   "本地路径",
			remote: "/srv/git/notes.git",
			base:   "https://git.example.com",
			wantOK: false,
		},
		{
			name:   "只有一段路径不是仓库",
			remote: "https://git.example.com/alice",
			base:   "https://git.example.com",
			wantOK: false,
		},
		{
			name:   "深层路径不属于仓库命名空间",
			remote: "https://git.example.com/alice/notes/sub.git",
			base:   "https://git.example.com",
			wantOK: false,
		},
		{
			name:   "空地址",
			remote: "",
			base:   "https://git.example.com",
			wantOK: false,
		},
		{
			name:   "没有实例地址",
			remote: "https://git.example.com/alice/notes.git",
			base:   "",
			wantOK: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ok, slug := remoteMatchesInstance(tc.remote, tc.base)
			if ok != tc.wantOK {
				t.Fatalf("匹配判定 = %v，期望 %v（remote=%q base=%q）", ok, tc.wantOK, tc.remote, tc.base)
			}
			if slug != tc.wantSlug {
				t.Fatalf("仓库路径 = %q，期望 %q", slug, tc.wantSlug)
			}
		})
	}
}

/* ------------------------------------------------------------------ */
/* 联网命令的环境                                                      */
/* ------------------------------------------------------------------ */

// NetworkEnv 带凭据时必须与 cloneEnv 给出同一套注入：两条链路共用一份实现，
// 免得其中一条悄悄丢了 helper 清空或作用域收敛。
func TestNetworkEnvReusesCloneInjection(t *testing.T) {
	cred := &Credentials{Token: "tok-123", URL: "https://git.example.com/alice/notes.git"}

	got := strings.Join(NetworkEnv(cred), "\n")
	want := strings.Join(cloneEnv(cred), "\n")
	if got != want {
		t.Fatalf("带凭据的联网环境与克隆环境不一致：\n%v", got)
	}
}

// 不带凭据时不注入任何认证配置，但终端提示仍然要关：GUI 里没有终端可输密码，
// git 挂在那里等输入比报一个明确的失败糟得多。
func TestNetworkEnvWithoutCredentialsStillDisablesPrompt(t *testing.T) {
	env := NetworkEnv(nil)

	if !hasEnv(env, "GIT_TERMINAL_PROMPT=0") {
		t.Fatalf("应当关闭终端提示，得到环境: %v", env)
	}
	for _, kv := range env {
		if strings.Contains(kv, "extraHeader") || strings.Contains(kv, "credential.helper") {
			t.Fatalf("无凭据时不该注入认证配置，得到 %q", kv)
		}
	}
}

// hasEnv 判断环境里是否有某一条完整的键值对。
//
// 不叫 envValue：clone_test.go 里已有一个按键取值版的同名 helper。
func hasEnv(env []string, want string) bool {
	for _, kv := range env {
		if kv == want {
			return true
		}
	}
	return false
}

// 令牌的作用域必须是这条命令真正访问的那个远端地址，且原样保留用户的写法。
func TestNetworkCredentialsScopesToActualRemote(t *testing.T) {
	dir := newRepo(t)
	// 用户手滑写成不带 .git 的形态：作用域就用这个形态，因为 git 发出的
	// 请求前缀与它一致；换成我们拼出来的地址反而匹配不上。
	runAt(t, dir, "remote", "add", "origin", "https://git.example.com/alice/notes")

	auth := &InstanceAuth{BaseURL: "https://git.example.com", Token: "tok-123"}
	cred := networkCredentials(dir, "origin", auth)
	if cred == nil {
		t.Fatal("本实例的远端应当注入凭据")
	}
	if cred.Token != "tok-123" {
		t.Fatalf("令牌不对: %q", cred.Token)
	}
	if cred.URL != "https://git.example.com/alice/notes" {
		t.Fatalf("作用域应当是 origin 的原样地址，得到 %q", cred.URL)
	}
}

// 判定矩阵：四种情况下只有"实例仓库 + 已登录"才注入。
func TestNetworkCredentialsDecisionMatrix(t *testing.T) {
	const instanceBase = "https://git.example.com"

	cases := []struct {
		name   string
		remote string
		auth   *InstanceAuth
		want   bool
	}{
		{
			name:   "实例仓库且已登录",
			remote: instanceBase + "/alice/notes.git",
			auth:   &InstanceAuth{BaseURL: instanceBase, Token: "tok"},
			want:   true,
		},
		{
			name:   "外部仓库",
			remote: "https://github.com/alice/notes.git",
			auth:   &InstanceAuth{BaseURL: instanceBase, Token: "tok"},
			want:   false,
		},
		{
			name:   "origin 被改成 ssh 写法",
			remote: "git@git.example.com:alice/notes.git",
			auth:   &InstanceAuth{BaseURL: instanceBase, Token: "tok"},
			want:   false,
		},
		{
			name:   "未登录（令牌为空）",
			remote: instanceBase + "/alice/notes.git",
			auth:   &InstanceAuth{BaseURL: instanceBase, Token: ""},
			want:   false,
		},
		{
			name:   "未连接实例",
			remote: instanceBase + "/alice/notes.git",
			auth:   nil,
			want:   false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := newRepo(t)
			runAt(t, dir, "remote", "add", "origin", tc.remote)

			cred := networkCredentials(dir, "origin", tc.auth)
			if (cred != nil) != tc.want {
				t.Fatalf("注入判定 = %v，期望 %v（cred=%+v）", cred != nil, tc.want, cred)
			}
			if cred != nil && strings.Contains(cred.URL, "tok") {
				t.Fatalf("令牌不该出现在作用域里: %q", cred.URL)
			}
		})
	}
}

// 远端名对不上时不注入：push 到 upstream、凭据按 origin 注入等于白配。
func TestNetworkCredentialsUnknownRemote(t *testing.T) {
	dir := newRepo(t)
	runAt(t, dir, "remote", "add", "fork", "https://git.example.com/alice/notes.git")

	auth := &InstanceAuth{BaseURL: "https://git.example.com", Token: "tok"}
	if cred := networkCredentials(dir, "origin", auth); cred != nil {
		t.Fatalf("origin 不存在时不该注入，得到 %+v", cred)
	}
	if cred := networkCredentials(dir, "", auth); cred != nil {
		t.Fatalf("远端名为空时不该注入，得到 %+v", cred)
	}
}

/* ------------------------------------------------------------------ */
/* push 计划：确认框与执行必须出自同一次计算                             */
/* ------------------------------------------------------------------ */

// 分支有上游时按上游推，不带 --set-upstream。
func TestPlanPushWithUpstream(t *testing.T) {
	dir := newTrackedRepo(t, "main")

	plan := PlanPush(dir, false)
	if plan.createsUpstream {
		t.Fatal("已有上游时不该再建立上游")
	}
	if plan.remote != "origin" {
		t.Fatalf("远端应当解析为 origin，得到 %q", plan.remote)
	}
	if !strings.Contains(plan.display, "origin main") {
		t.Fatalf("命令里应写明远端与分支，得到 %q", plan.display)
	}
	if strings.Contains(plan.display, "--set-upstream") || strings.Contains(plan.display, "--force") {
		t.Fatalf("普通推送不该带这些参数，得到 %q", plan.display)
	}
}

// 强制推送要显示完整命令，且远端与分支仍然写清。
func TestPlanPushForce(t *testing.T) {
	dir := newTrackedRepo(t, "main")

	plan := PlanPush(dir, true)
	if !strings.Contains(plan.display, "--force-with-lease") {
		t.Fatalf("强制推送应使用 --force-with-lease，得到 %q", plan.display)
	}
	if strings.Contains(plan.display, " --force ") || strings.HasSuffix(plan.display, " --force") {
		t.Fatalf("不该出现裸 --force（会覆盖别人的提交），得到 %q", plan.display)
	}
}

// 第一次推送本地新建分支：终端里 git 会直接建议 `--set-upstream origin main`，
// 桌面端就跑同一条，而不是让用户读一句看不懂的 "no tracking information"。
func TestPlanPushCreatesUpstreamForLocalBranch(t *testing.T) {
	dir := newRepoWithCommit(t, "feature/x")
	runAt(t, dir, "remote", "add", "origin", "https://git.example.com/alice/notes.git")

	plan := PlanPush(dir, false)
	if !plan.createsUpstream {
		t.Fatal("没有上游时应当建立上游")
	}
	if !strings.Contains(plan.display, "--set-upstream") {
		t.Fatalf("命令里应写明会建立上游，得到 %q", plan.display)
	}
	// 分支名带斜杠时不能按第一段切错。
	if !strings.Contains(plan.display, " origin feature/x") {
		t.Fatalf("应当推 origin feature/x，得到 %q", plan.display)
	}
	if plan.remote != "origin" {
		t.Fatalf("凭据作用域要按这个远端算，得到 %q", plan.remote)
	}
}

// 游离 HEAD（没有分支）时不替用户编一个分支名去推：猜错会把提交落到
// 一个他没打算碰的分支上，退回裸 git push 让 git 自己报错。
func TestPlanPushKeepsItPlainWhenBranchUnknown(t *testing.T) {
	dir := newRepoWithCommit(t, "main")
	runAt(t, dir, "remote", "add", "origin", "https://git.example.com/alice/notes.git")
	// detached：HEAD 直接指向提交。
	sha := strings.TrimSpace(runAt(t, dir, "rev-parse", "HEAD"))
	runAt(t, dir, "checkout", "--detach", sha)

	plan := PlanPush(dir, false)
	if plan.createsUpstream {
		t.Fatal("游离 HEAD 时不该建立上游")
	}
	if plan.display != "git push" {
		t.Fatalf("应退回通用形式，得到 %q", plan.display)
	}
}

// 没有远端的纯本地仓库同样不建立上游。
func TestPlanPushWithoutAnyRemote(t *testing.T) {
	dir := newRepoWithCommit(t, "main")

	plan := PlanPush(dir, false)
	if plan.createsUpstream {
		t.Fatal("没有远端时不该建立上游")
	}
	if plan.remote != "" {
		t.Fatalf("不该解析出远端名，得到 %q", plan.remote)
	}
}

// 用户把正主远端叫别的名字时，替他配的那个远端优先于 origin。
func TestPlanPushHonoursPushDefault(t *testing.T) {
	dir := newRepoWithCommit(t, "main")
	runAt(t, dir, "remote", "add", "origin", "https://github.com/fork/notes.git")
	runAt(t, dir, "remote", "add", "upstream", "https://git.example.com/alice/notes.git")
	runAt(t, dir, "config", "remote.pushdefault", "upstream")

	plan := PlanPush(dir, false)
	if !strings.Contains(plan.display, " upstream main") {
		t.Fatalf("应当推到 remote.pushdefault 指定的远端，得到 %q", plan.display)
	}
	if plan.remote != "upstream" {
		t.Fatalf("凭据作用域要跟着改成 upstream，得到 %q", plan.remote)
	}
}

// 按分支配的 pushremote 优先于全局设置：fork 工作流里常见。
func TestPlanPushHonoursBranchPushRemote(t *testing.T) {
	dir := newRepoWithCommit(t, "main")
	runAt(t, dir, "remote", "add", "origin", "https://git.example.com/alice/notes.git")
	runAt(t, dir, "remote", "add", "personal", "https://github.com/me/notes.git")
	runAt(t, dir, "config", "remote.pushdefault", "origin")
	runAt(t, dir, "config", "branch.main.pushremote", "personal")

	plan := PlanPush(dir, false)
	if !strings.Contains(plan.display, " personal main") {
		t.Fatalf("分支级配置应当胜出，得到 %q", plan.display)
	}
}

// 配置指向一个不存在的远端时不能照着用：那会让 git 报 "no such remote"，
// 用户根本不知道这条建议是从哪来的。
func TestPlanPushIgnoresDanglingPushDefault(t *testing.T) {
	dir := newRepoWithCommit(t, "main")
	runAt(t, dir, "remote", "add", "origin", "https://git.example.com/alice/notes.git")
	runAt(t, dir, "config", "remote.pushdefault", "gone")

	plan := PlanPush(dir, false)
	if !strings.Contains(plan.display, " origin main") {
		t.Fatalf("失效的 pushdefault 应退回 origin，得到 %q", plan.display)
	}
}

// PushCommand 与 Push 用的是同一个计划：确认框里那条就是真跑的那条。
func TestPushCommandMatchesPlan(t *testing.T) {
	dir := newRepoWithCommit(t, "main")
	runAt(t, dir, "remote", "add", "origin", "https://git.example.com/alice/notes.git")

	if got := PushCommand(dir, false); got != PlanPush(dir, false).display {
		t.Fatalf("确认框与执行不一致:\n  PushCommand = %q\n  PlanPush    = %q", got, PlanPush(dir, false).display)
	}
}

/* ------------------------------------------------------------------ */
/* 测试夹具：不碰传输                                                  */
/* ------------------------------------------------------------------ */

// newTrackedRepo 造一个"分支已建立上游"的仓库，但不做任何传输。
//
// 上游关系完全由 ref + 配置表达：手写 refs/remotes/origin/<branch> 指向本地
// 那个提交，再配 branch.<name>.{remote,merge}——`git push` 成功之后仓库里
// 多出来的也就是这几样，因此与真实推送过的状态无从区分。不做真传输是因为
// 本机测试环境跑不动 git 的传输子进程，而这条链路要测的是"命令怎么拼"和
// "凭据按哪个远端注入"，两者都不需要远端真的存在。
func newTrackedRepo(t *testing.T, branch string) string {
	t.Helper()
	dir := newRepoWithCommit(t, branch)

	sha := strings.TrimSpace(runAt(t, dir, "rev-parse", "HEAD"))
	write(t, dir, filepath.Join(".git", "refs", "remotes", "origin", branch), sha+"\n")

	runAt(t, dir, "remote", "add", "origin", "https://git.example.com/alice/notes.git")
	runAt(t, dir, "config", "branch."+branch+".remote", "origin")
	runAt(t, dir, "config", "branch."+branch+".merge", "refs/heads/"+branch)
	return dir
}

// newRepoWithCommit 造一个有初始提交、停在指定分支上的仓库。
func newRepoWithCommit(t *testing.T, branch string) string {
	t.Helper()
	dir := newRepo(t)
	if branch != "main" {
		runAt(t, dir, "checkout", "-b", branch)
	}
	write(t, dir, "a.txt", "1\n")
	runAt(t, dir, "add", "a.txt")
	runAt(t, dir, "commit", "-m", "one")
	return dir
}
