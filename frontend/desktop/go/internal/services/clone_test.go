package services

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 克隆服务的职责边界：把"要拉哪个仓库、放到哪"翻译成一次 git 调用，
// 并在结束后登记成工作副本。凭据只在该次进程里存在。

func TestCloneRemoteRejectsEmptyTargets(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := filepath.Join(t.TempDir(), "repo")

	cases := []struct {
		name   string
		target CloneTarget
	}{
		{"没有来源", CloneTarget{Dir: dir}},
		{"两个来源同时给", CloneTarget{RepoPath: "alice/notes", URL: "https://example.invalid/a.git", Dir: dir}},
		{"没有目录", CloneTarget{RepoPath: "alice/notes"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := svc.CloneRemote(tc.target); err == nil {
				t.Fatal("应当报错")
			}
		})
	}
}

// 实例仓库路径必须在连上实例且已登录之后才能拼地址。
func TestCloneRemoteInstanceNeedsSession(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	BindCloneAuth(func() CloneAuth { return CloneAuth{} })
	t.Cleanup(func() { BindCloneAuth(nil) })

	_, err := svc.CloneRemote(CloneTarget{
		RepoPath: "alice/notes",
		Dir:      filepath.Join(t.TempDir(), "notes"),
	})
	if err == nil || !strings.Contains(err.Error(), "尚未连接实例") {
		t.Fatalf("期望提示未连接实例，得到: %v", err)
	}

	BindCloneAuth(func() CloneAuth {
		return CloneAuth{BaseURL: "https://git.example.com"}
	})
	_, err = svc.CloneRemote(CloneTarget{
		RepoPath: "alice/notes",
		Dir:      filepath.Join(t.TempDir(), "notes"),
	})
	if err == nil || !strings.Contains(err.Error(), "登录已失效") {
		t.Fatalf("期望提示登录失效，得到: %v", err)
	}
}

// 实例仓库带 Bearer 令牌，外部地址不注入凭据——这一条是安全边界，
// 写错了会把用户令牌递给第三方主机。
func TestCloneRequestCredentialScope(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	BindCloneAuth(func() CloneAuth {
		return CloneAuth{BaseURL: "https://git.example.com:8443", Token: "tok-123"}
	})
	t.Cleanup(func() { BindCloneAuth(nil) })

	dir := filepath.Join(t.TempDir(), "notes")
	req, cred, err := svc.cloneRequest(CloneTarget{RepoPath: "alice/notes", Dir: dir})
	if err != nil {
		t.Fatalf("实例克隆参数构造失败: %v", err)
	}
	if req.URL != "https://git.example.com:8443/alice/notes.git" {
		t.Fatalf("克隆地址不对: %s", req.URL)
	}
	if cred == nil || cred.Token != "tok-123" {
		t.Fatalf("实例克隆应当带上令牌，得到 %+v", cred)
	}
	// 作用域必须是完整仓库地址：收成主机就会把令牌散给同主机上的其他仓库。
	if cred.URL != req.URL {
		t.Fatalf("凭据作用域应当是完整仓库地址 %q，得到 %q", req.URL, cred.URL)
	}
	if strings.Contains(req.URL, "tok-123") {
		t.Fatal("令牌绝不能出现在地址里")
	}

	extReq, extCred, err := svc.cloneRequest(CloneTarget{
		URL: "https://github.com/example/other.git",
		Dir: filepath.Join(t.TempDir(), "other"),
	})
	if err != nil {
		t.Fatalf("外部克隆参数构造失败: %v", err)
	}
	if extReq.URL != "https://github.com/example/other.git" {
		t.Fatalf("外部地址不该被改写: %s", extReq.URL)
	}
	if extCred != nil {
		t.Fatal("外部地址不该注入凭据")
	}
}

// 带密码的地址会被 git 写进 .git/config，必须在动手前挡住。
func TestCloneRequestRejectsPasswordURL(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	_, _, err := svc.cloneRequest(CloneTarget{
		URL: "https://alice:secret@example.com/a.git",
		Dir: filepath.Join(t.TempDir(), "a"),
	})
	if err == nil || !strings.Contains(err.Error(), "不要带密码") {
		t.Fatalf("期望拒绝带密码的地址，得到: %v", err)
	}
}

// 同一个目录不能同时跑两次克隆，否则两个 git 会往同一处写。
func TestRegisterCloneRejectsDuplicate(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := filepath.Join(t.TempDir(), "repo")

	if err := svc.registerClone(dir, func() {}); err != nil {
		t.Fatalf("首次登记应当成功: %v", err)
	}
	if err := svc.registerClone(dir, func() {}); !errors.Is(err, errCloneInProgress) {
		t.Fatalf("重复登记应当被拒，得到: %v", err)
	}
	svc.unregisterClone(dir)
	if err := svc.registerClone(dir, func() {}); err != nil {
		t.Fatalf("登记释放后应当可以再来: %v", err)
	}
	svc.unregisterClone(dir)
}

func TestCancelCloneWithoutJob(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	err := svc.CancelClone(filepath.Join(t.TempDir(), "nope"))
	if !errors.Is(err, errCloneNotRunning) {
		t.Fatalf("期望 errCloneNotRunning，得到: %v", err)
	}
}

// 端到端：用本地仓库当远端，验证克隆 + 登记 + 进度回调这条链路。
func TestCloneRemoteFromLocalPath(t *testing.T) {
	needGit(t)
	svc := newTestWorkingCopyService(t)

	src := initRepo(t)
	writeFile(t, src, "notes.md", "# notes\n")
	gitIn(t, src, "add", ".")
	gitIn(t, src, "commit", "-m", "initial")

	var phases []string
	BindCloneProgress(func(ev CloneProgressEvent) { phases = append(phases, string(ev.Phase)) })
	t.Cleanup(func() { BindCloneProgress(nil) })

	dir := filepath.Join(t.TempDir(), "cloned")
	wc, err := svc.CloneRemote(CloneTarget{URL: src, Dir: dir})
	if err != nil {
		t.Fatalf("克隆失败: %v", err)
	}
	if wc.Path != dir && !strings.EqualFold(filepath.Clean(wc.Path), filepath.Clean(dir)) {
		t.Fatalf("登记路径不对: %s", wc.Path)
	}
	if wc.Branch != "main" {
		t.Fatalf("分支应为 main，得到 %q", wc.Branch)
	}
	if _, err := os.Stat(filepath.Join(dir, "notes.md")); err != nil {
		t.Fatalf("克隆后应当有 notes.md: %v", err)
	}
	if len(phases) == 0 {
		t.Fatal("应当收到过进度事件")
	}

	// 登记后能按 id 查到——这正是 clone 完成就走 Add 的意义。
	if _, err := svc.Status(wc.ID); err != nil {
		t.Fatalf("按 id 查状态失败: %v", err)
	}
}

// 目标目录已被占用时不能覆盖用户的文件。
func TestCloneRemoteRefusesExistingDir(t *testing.T) {
	needGit(t)
	svc := newTestWorkingCopyService(t)

	src := initRepo(t)
	writeFile(t, src, "notes.md", "# notes\n")
	gitIn(t, src, "add", ".")
	gitIn(t, src, "commit", "-m", "initial")

	dir := filepath.Join(t.TempDir(), "occupied")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	keep := filepath.Join(dir, "keep.txt")
	if err := os.WriteFile(keep, []byte("keep"), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	if _, err := svc.CloneRemote(CloneTarget{URL: src, Dir: dir}); err == nil {
		t.Fatal("目标已存在时应当报错")
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatal("失败路径不该删掉用户已有的文件")
	}
}
