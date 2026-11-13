package git

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/kustos/kustos-desktop/internal/platform/noconsole"
)

/* ------------------------------------------------------------------ */
/* 进度解析                                                            */
/* ------------------------------------------------------------------ */

func TestParseCloneProgressPhases(t *testing.T) {
	cases := []struct {
		line  string
		phase ClonePhase
		pct   int
		ok    bool
	}{
		{"Cloning into 'dst'...", ClonePhaseStarting, -1, true},
		{"remote: Counting objects:  45% (45/100)", ClonePhaseCounting, 45, true},
		{"remote: Compressing objects: 100% (10/10), done.", ClonePhaseCompressing, 100, true},
		{"Receiving objects:  12% (1200/10000), 3.40 MiB | 1.20 MiB/s", ClonePhaseReceiving, 12, true},
		{"Resolving deltas: 100% (400/400), done.", ClonePhaseResolving, 100, true},
		{"Updating files:  80% (800/1000)", ClonePhaseCheckout, 80, true},
		// 旧版 git 的措辞也要认。
		{"Checking out files: 100% (1000/1000), done.", ClonePhaseCheckout, 100, true},
		// 不是进度行。
		{"fatal: repository 'https://x/y.git/' not found", "", -1, false},
		{"", "", -1, false},
	}
	for _, c := range cases {
		got, ok := parseCloneProgress(c.line)
		if ok != c.ok {
			t.Fatalf("parseCloneProgress(%q) ok = %v，期望 %v", c.line, ok, c.ok)
		}
		if !ok {
			continue
		}
		if got.Phase != c.phase || got.Percent != c.pct {
			t.Fatalf("parseCloneProgress(%q) = %+v，期望 {%s %d}", c.line, got, c.phase, c.pct)
		}
	}
}

// 进度行用 \r 原地刷新：只按 \n 切会把整个下载过程并成一行，
// 百分比就永远停在最后一次。
func TestSplitProgressSplitsCarriageReturn(t *testing.T) {
	input := "Receiving objects: 10%\rReceiving objects: 50%\rReceiving objects: 100%\rdone\n"
	var lines []string
	rest := []byte(input)
	for {
		adv, token, err := splitProgress(rest, false)
		if err != nil {
			t.Fatalf("splitProgress 出错: %v", err)
		}
		if adv == 0 {
			break
		}
		rest = rest[adv:]
		if len(token) > 0 {
			lines = append(lines, string(token))
		}
	}
	want := []string{
		"Receiving objects: 10%",
		"Receiving objects: 50%",
		"Receiving objects: 100%",
		"done",
	}
	if len(lines) != len(want) {
		t.Fatalf("切出 %d 行，期望 %d 行: %q", len(lines), len(want), lines)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Fatalf("第 %d 行 = %q，期望 %q", i, lines[i], want[i])
		}
	}
}

/* ------------------------------------------------------------------ */
/* 地址构造与校验                                                       */
/* ------------------------------------------------------------------ */

func TestInstanceCloneURL(t *testing.T) {
	cases := []struct {
		base    string
		repo    string
		want    string
		wantErr bool
	}{
		{"https://git.example.com", "alice/notes", "https://git.example.com/alice/notes.git", false},
		{"https://git.example.com/", "alice/notes", "https://git.example.com/alice/notes.git", false},
		// 带端口与子路径的实例地址都要保留。
		{"http://10.11.78.211:8080/kustos", "alice/notes", "http://10.11.78.211:8080/kustos/alice/notes.git", false},
		// 仓库名里允许点与下划线：真实仓库名常有。
		{"https://git.example.com", "team_a/api.v2", "https://git.example.com/team_a/api.v2.git", false},
		// 形状不合法：少一段、多一段、带 .git 后缀、带空白。
		{"https://git.example.com", "notes", "", true},
		{"https://git.example.com", "a/b/c", "", true},
		{"https://git.example.com", "alice/notes.git", "", true},
		{"https://git.example.com", "alice notes/x", "", true},
		{"https://git.example.com", "", "", true},
		// 往上跳一层不是仓库名。
		{"https://git.example.com", "../etc", "", true},
		{"https://git.example.com", "alice/..", "", true},
		// 协议必须是 http(s)：ssh 地址不能靠这条拼。
		{"git@git.example.com:alice", "alice/notes", "", true},
	}
	for _, c := range cases {
		got, err := InstanceCloneURL(c.base, c.repo)
		if c.wantErr {
			if err == nil {
				t.Fatalf("InstanceCloneURL(%q, %q) 应当报错，却得到 %q", c.base, c.repo, got)
			}
			continue
		}
		if err != nil {
			t.Fatalf("InstanceCloneURL(%q, %q) 报错: %v", c.base, c.repo, err)
		}
		if got != c.want {
			t.Fatalf("InstanceCloneURL(%q, %q) = %q，期望 %q", c.base, c.repo, got, c.want)
		}
	}
}

func TestValidateRemoteURL(t *testing.T) {
	ok := []string{
		"https://git.example.com/alice/notes.git",
		"http://127.0.0.1:8080/alice/notes.git",
		"git@git.example.com:alice/notes.git",
		"ssh://git@git.example.com:22/alice/notes.git",
		// 用户名不算密码：有些实例用它挑账号。
		"https://alice@git.example.com/alice/notes.git",
		// 本地路径也是合法克隆源，不该被这条拦住。
		"file:///tmp/notes.git",
		"/tmp/notes.git",
	}
	for _, raw := range ok {
		if err := ValidateRemoteURL(raw); err != nil {
			t.Fatalf("ValidateRemoteURL(%q) 不该报错: %v", raw, err)
		}
	}

	bad := map[string]string{
		"":    "空",
		"   ": "空白",
		"https://git.example.com/al ice/notes.git": "空白字符",
		// 带密码会被 git 原样写进 .git/config。
		"https://alice:s3cr3t@git.example.com/alice/notes.git": "密码",
	}
	for raw := range bad {
		if err := ValidateRemoteURL(raw); err == nil {
			t.Fatalf("ValidateRemoteURL(%q) 应当报错", raw)
		}
	}
}

func TestCredentialsHost(t *testing.T) {
	cases := map[string]string{
		"https://git.example.com/alice/notes.git":   "git.example.com",
		"http://10.11.78.211:8080/alice/notes.git":  "10.11.78.211",
		"https://alice:tok@git.example.com/x/y.git": "git.example.com",
		"git@git.example.com:alice/notes.git":       "",
	}
	for raw, want := range cases {
		if got := CredentialsHost(raw); got != want {
			t.Fatalf("CredentialsHost(%q) = %q，期望 %q", raw, got, want)
		}
	}
}

/* ------------------------------------------------------------------ */
/* 凭据注入                                                            */
/* ------------------------------------------------------------------ */

// envValue 取环境变量切片里某个键的值，不存在时返回 ok=false。
func envValue(env []string, key string) (string, bool) {
	prefix := key + "="
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			return strings.TrimPrefix(kv, prefix), true
		}
	}
	return "", false
}

// 有凭据时，令牌必须落到 `http.<完整仓库地址>.extraHeader` 上。
// 权限不足时必须给出"换个位置"的指示，而不是把系统原文甩出去。
func TestPermissionErrorMessage(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Kustos")

	denied := &os.PathError{Op: "mkdir", Path: dir, Err: os.ErrPermission}
	msg := permissionError(dir, denied).Error()
	if !strings.Contains(msg, "没有权限") || !strings.Contains(msg, dir) {
		t.Fatalf("权限错误应当指出位置并说明没权限，得到: %s", msg)
	}

	// 其它错误仍要带上底层原因，否则排查时无从下手。
	other := permissionError(dir, errors.New("disk full")).Error()
	if !strings.Contains(other, "disk full") {
		t.Fatalf("非权限错误应当保留原因，得到: %s", other)
	}
}

// 令牌只对本次克隆的那个仓库生效，且不出现在键名里。
//
// 作用域是完整地址而不是主机：一次 clone 可能牵出第三方地址，按主机散令牌
// 等于把它交给陌生人。
func TestCloneEnvScopesTokenToRepository(t *testing.T) {
	const repoURL = "https://git.example.com:8443/alice/notes.git"
	env := cloneEnv(&Credentials{Token: "tok-123", URL: repoURL})

	value, ok := configValue(env, "http."+repoURL+".extraHeader")
	if !ok {
		t.Fatalf("应当写入 http.%s.extraHeader，得到环境: %v", repoURL, env)
	}
	if value != "Authorization: Bearer tok-123" {
		t.Fatalf("头部应当是 Bearer 令牌，得到 %q", value)
	}
	// 作用域（键）里绝不能出现令牌。
	for _, kv := range env {
		if strings.HasPrefix(kv, "GIT_CONFIG_KEY_") && strings.Contains(kv, "tok-123") {
			t.Fatalf("作用域键里不该出现令牌: %q", kv)
		}
	}
}

// configValue 在 GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n 成对变量里按键取值。
func configValue(env []string, key string) (string, bool) {
	for i := 0; ; i++ {
		k, ok := envValue(env, "GIT_CONFIG_KEY_"+strconv.Itoa(i))
		if !ok {
			return "", false
		}
		if k == key {
			return envValue(env, "GIT_CONFIG_VALUE_"+strconv.Itoa(i))
		}
	}
}

// 有凭据时要把用户机器上的 helper 清空：否则 401 之后 GCM/钥匙串会弹窗，
// 而桌面端没有终端可交互，弹出来的窗口既解释不清也没法用。
func TestCloneEnvClearsCredentialHelper(t *testing.T) {
	env := cloneEnv(&Credentials{Token: "tok-123", URL: "https://git.example.com/a/b.git"})

	found := false
	for i := 0; ; i++ {
		key, ok := envValue(env, "GIT_CONFIG_KEY_"+strconv.Itoa(i))
		if !ok {
			break
		}
		if key == "credential.helper" {
			value, _ := envValue(env, "GIT_CONFIG_VALUE_"+strconv.Itoa(i))
			if value != "" {
				t.Fatalf("helper 必须被清空，得到 %q", value)
			}
			found = true
		}
	}
	if !found {
		t.Fatalf("有凭据时应当显式清空 credential.helper，得到环境: %v", env)
	}
}

// 没有凭据时（外部地址）什么都不注入：那条链路由用户自己的 git 配置负责。
func TestCloneEnvWithoutCredentialsAddsNoHeader(t *testing.T) {
	env := cloneEnv(nil)
	for _, kv := range env {
		if strings.Contains(kv, "extraHeader") || strings.Contains(kv, "credential.helper") {
			t.Fatalf("无凭据时不该注入认证配置，得到 %q", kv)
		}
	}
}

// 令牌为空或作用域为空时同样不注入：半个凭据只会让 git 迷惑。
func TestCloneEnvIgnoresIncompleteCredentials(t *testing.T) {
	for _, cred := range []*Credentials{
		{Token: "", URL: "https://git.example.com/a/b.git"},
		{Token: "tok-123", URL: ""},
		{Token: "   ", URL: "https://git.example.com/a/b.git"},
	} {
		for _, kv := range cloneEnv(cred) {
			if strings.Contains(kv, "extraHeader") {
				t.Fatalf("凭据不完整时不该注入头部，得到 %q", kv)
			}
		}
	}
}

// GIT_CONFIG_COUNT 只能出现一次：gitEnv 自带一份，cloneEnv 又按数量重拼，
// 两份并存时哪份生效取决于进程环境的去重规则。
func TestCloneEnvEmitsSingleConfigCount(t *testing.T) {
	env := cloneEnv(&Credentials{Token: "tok-123", URL: "https://git.example.com/a/b.git"})

	count := 0
	for _, kv := range env {
		if strings.HasPrefix(kv, "GIT_CONFIG_COUNT=") {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("GIT_CONFIG_COUNT 应当恰好出现一次，得到 %d 次: %v", count, env)
	}

	// 数量声明必须与实际给出的键值对一致，否则 git 会忽略多余的或读不到。
	raw, _ := envValue(env, "GIT_CONFIG_COUNT")
	n, err := strconv.Atoi(raw)
	if err != nil {
		t.Fatalf("GIT_CONFIG_COUNT 不是整数: %q", raw)
	}
	for i := 0; i < n; i++ {
		if _, ok := envValue(env, "GIT_CONFIG_KEY_"+strconv.Itoa(i)); !ok {
			t.Fatalf("声明了 %d 对配置，但缺少 GIT_CONFIG_KEY_%d", n, i)
		}
		if _, ok := envValue(env, "GIT_CONFIG_VALUE_"+strconv.Itoa(i)); !ok {
			t.Fatalf("声明了 %d 对配置，但缺少 GIT_CONFIG_VALUE_%d", n, i)
		}
	}
	if _, ok := envValue(env, "GIT_CONFIG_KEY_"+strconv.Itoa(n)); ok {
		t.Fatalf("声明了 %d 对配置，却多给出 GIT_CONFIG_KEY_%d", n, n)
	}
}

// 桌面端没有终端可交互：缺凭据时让 git 立刻失败，而不是挂在那里等一个
// 永远不会有人输入的密码。
func TestCloneEnvDisablesTerminalPrompt(t *testing.T) {
	for _, cred := range []*Credentials{nil, {Token: "tok-123", URL: "https://git.example.com/a/b.git"}} {
		if value, ok := envValue(cloneEnv(cred), "GIT_TERMINAL_PROMPT"); !ok || value != "0" {
			t.Fatalf("必须设 GIT_TERMINAL_PROMPT=0，得到 %q (存在=%v)", value, ok)
		}
	}
}

/* ------------------------------------------------------------------ */
/* 真实克隆                                                            */
/* ------------------------------------------------------------------ */

// sourceRepo 造一个有两次提交的源仓库，返回其路径。
func sourceRepo(t *testing.T) string {
	t.Helper()
	dir := newRepo(t)
	write(t, dir, "notes.md", "hello\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")
	write(t, dir, "readme.md", "world\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "docs")
	return dir
}

func TestCloneLocalRepository(t *testing.T) {
	needGit(t)
	src := sourceRepo(t)
	dst := filepath.Join(t.TempDir(), "clone")

	var phases []ClonePhase
	err := Clone(context.Background(), CloneRequest{URL: src, Dir: dst}, nil, func(p CloneProgress) {
		phases = append(phases, p.Phase)
	})
	if err != nil {
		t.Fatalf("Clone 失败: %v", err)
	}

	// 内容与原仓库一致：两个提交都在，文件也检出到工作区。
	if branch, err := CurrentBranch(dst); err != nil || branch != "main" {
		t.Fatalf("克隆后的分支 = %q, err = %v，期望 main", branch, err)
	}
	if _, err := os.Stat(filepath.Join(dst, "notes.md")); err != nil {
		t.Fatalf("克隆后缺少 notes.md: %v", err)
	}
	st, err := RepoStatus(dst)
	if err != nil {
		t.Fatalf("RepoStatus 失败: %v", err)
	}
	if st.Dirty {
		t.Fatalf("刚克隆出来的仓库不该是脏的: %+v", st)
	}
	// 进度至少报了 "Cloning into"：本地克隆也可能快到只有这一条，
	// 因此只要求非空而不是要求出现 receiving。
	if len(phases) == 0 {
		t.Fatal("应当至少回报一次进度")
	}
}

// 目标目录已存在时必须直接拒绝：不覆盖、不合并。
func TestCloneRejectsExistingTarget(t *testing.T) {
	needGit(t)
	src := sourceRepo(t)
	parent := t.TempDir()
	dst := filepath.Join(parent, "occupied")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	write(t, dst, "keep.txt", "不要动我\n")

	err := Clone(context.Background(), CloneRequest{URL: src, Dir: dst}, nil, nil)
	if !errors.Is(err, ErrTargetExists) {
		t.Fatalf("期望 ErrTargetExists，得到 %v", err)
	}
	// 原有内容必须还在。
	if _, statErr := os.Stat(filepath.Join(dst, "keep.txt")); statErr != nil {
		t.Fatalf("拒绝克隆不该动已有目录: %v", statErr)
	}
}

// 取消要杀掉 git 并删掉半成品目录，否则下次再试会被 ErrTargetExists 挡住。
func TestCloneCancelRemovesTarget(t *testing.T) {
	needGit(t)

	// 用一个不存在的远端地址不适用：那会立刻失败而不是"来得及取消"。
	// 这里直接取消一个已取消的 context，覆盖的是同一条清理路径。
	src := sourceRepo(t)
	dst := filepath.Join(t.TempDir(), "cancelled")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := Clone(ctx, CloneRequest{URL: src, Dir: dst}, nil, nil)
	if err == nil {
		t.Fatal("取消后的克隆必须返回错误")
	}
	if _, statErr := os.Stat(dst); !os.IsNotExist(statErr) {
		t.Fatalf("取消后不该留下目标目录，stat 得到 %v", statErr)
	}
}

// 远端不存在时要给出 git 的原文，而不是只有 "exit status 128"。
func TestCloneFailureKeepsGitMessage(t *testing.T) {
	needGit(t)
	missing := filepath.Join(t.TempDir(), "nope")
	dst := filepath.Join(t.TempDir(), "clone")

	err := Clone(context.Background(), CloneRequest{URL: missing, Dir: dst}, nil, nil)
	if err == nil {
		t.Fatal("克隆不存在的仓库必须失败")
	}
	msg := err.Error()
	if strings.Contains(msg, "exit status") && !strings.Contains(msg, "does not exist") && !strings.Contains(msg, "not found") {
		t.Fatalf("错误里应当带 git 原文，得到: %s", msg)
	}
	if _, statErr := os.Stat(dst); !os.IsNotExist(statErr) {
		t.Fatalf("失败后不该留下目标目录，stat 得到 %v", statErr)
	}
}

/* ------------------------------------------------------------------ */
/* 凭据作用域（交给 git 自己判定）                                      */
/* ------------------------------------------------------------------ */

// 让 git 自己回答"这个头部会不会发给这个地址"。
//
// 断言的是 git 的匹配结果而不是我们的字符串拼接：作用域写错时字符串看着没错，
// 但令牌会发给不该发的主机（或者干脆不发给该发的主机）。
func gitHeaderFor(t *testing.T, env []string, probe string) (string, error) {
	t.Helper()
	cmd := exec.Command("git", "config", "--get-urlmatch", "http.extraheader", probe)
	cmd.Env = env
	noconsole.Hide(cmd)
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// 目标仓库自己要能拿到令牌，否则私有仓库根本克隆不下来。
func TestCloneEnvHeaderReachesOwnRepository(t *testing.T) {
	needGit(t)
	const repoURL = "https://git.example.com:8443/alice/notes.git"
	env := cloneEnv(&Credentials{Token: "tok-123", URL: repoURL})

	got, err := gitHeaderFor(t, env, repoURL+"/info/refs")
	if err != nil {
		t.Fatalf("git 应当认出这个头部: %v", err)
	}
	if got != "Authorization: Bearer tok-123" {
		t.Fatalf("头部内容不对，得到 %q", got)
	}
}

// 同一主机上的另一个仓库不能拿到令牌：这是"令牌不外流"的底线，
// 也顺带证明作用域没有退化到主机级。
func TestCloneEnvHeaderScopedToRepositoryNotHost(t *testing.T) {
	needGit(t)
	const repoURL = "https://git.example.com:8443/alice/notes.git"
	env := cloneEnv(&Credentials{Token: "tok-123", URL: repoURL})

	for _, probe := range []string{
		"https://git.example.com:8443/alice/other.git/info/refs",
		"https://git.example.com:8443/notes.git/info/refs",
	} {
		if got, err := gitHeaderFor(t, env, probe); err == nil && strings.Contains(got, "tok-123") {
			t.Fatalf("%s 不该拿到令牌，得到 %q", probe, got)
		}
	}
}

// 端口不同就是不同的源，同样不能拿到令牌。
func TestCloneEnvHeaderScopedByPort(t *testing.T) {
	needGit(t)
	const repoURL = "https://git.example.com:8443/alice/notes.git"
	env := cloneEnv(&Credentials{Token: "tok-123", URL: repoURL})

	if got, err := gitHeaderFor(t, env, "https://git.example.com/alice/notes.git/info/refs"); err == nil && strings.Contains(got, "tok-123") {
		t.Fatalf("换端口后不该拿到令牌，得到 %q", got)
	}
}

