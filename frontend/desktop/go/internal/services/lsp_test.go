package services

import (
	"bufio"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/kustos/kustos-desktop/internal/lsp"
	"github.com/kustos/kustos-desktop/internal/store"
)

// fakeLSPEnv 让测试进程的副本充当假语言服务器。
const fakeLSPEnv = "KUSTOS_SERVICES_FAKE_LSP"

// TestFakeLSPProcess 在设置了环境变量时充当假语言服务器；正常测试运行时被跳过。
//
// 不真的拉 gopls / tsserver：这一层验的是准入判断与信任记录，进程本身只要
// "起来、能收帧、能被杀掉"就够了，而真实服务器在 CI 上未必装得全。
func TestFakeLSPProcess(t *testing.T) {
	if os.Getenv(fakeLSPEnv) == "" {
		t.Skip("不是假服务器进程")
	}
	r := bufio.NewReader(os.Stdin)
	for {
		body, err := lsp.ReadFrame(r)
		if err != nil {
			break
		}
		if err := lsp.WriteFrame(os.Stdout, body); err != nil {
			break
		}
	}
	// 直接退出而不是让测试框架收尾：框架会往 stdout 打 "PASS"，
	// 那会混进帧流里。
	os.Exit(0)
}

// fakeLSPCommand 拉起当前测试进程的副本当语言服务器。
func fakeLSPCommand(ctx context.Context, _ string, _ ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=TestFakeLSPProcess")
	cmd.Env = append(os.Environ(), fakeLSPEnv+"=1")
	return cmd
}

// newTestLSPService 造一个不真拉外部程序的语言服务器服务。
func newTestLSPService(t *testing.T) (*LSPService, func()) {
	t.Helper()
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	pool := lsp.NewPool(lsp.Options{
		Command: fakeLSPCommand,
		Resolve: func(lsp.Language) (string, bool) { return os.Args[0], true },
	})
	return NewLSPService(db, pool), func() { pool.Close() }
}

func TestEnsureRejectsUntrustedWorkspace(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	dir := t.TempDir()
	writeFile(t, dir, "go.mod", "module example.invalid/demo\n")

	_, err := svc.Ensure(dir, "go")
	if !errors.Is(err, ErrWorkspaceUntrusted) {
		t.Fatalf("未信任的工作区应当拒绝，实际 %v", err)
	}
}

func TestEnsureRejectsExplicitlyUntrustedWorkspace(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	dir := t.TempDir()
	writeFile(t, dir, "go.mod", "module example.invalid/demo\n")
	if err := svc.SetTrust(dir, false); err != nil {
		t.Fatalf("记录拒绝失败: %v", err)
	}

	_, err := svc.Ensure(dir, "go")
	if !errors.Is(err, ErrWorkspaceUntrusted) {
		t.Fatalf("明确拒绝过的目录应当拒绝，实际 %v", err)
	}
}

func TestEnsureStartsServerForTrustedWorkspace(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	dir := t.TempDir()
	writeFile(t, dir, "go.mod", "module example.invalid/demo\n")
	if err := svc.SetTrust(dir, true); err != nil {
		t.Fatalf("记录信任失败: %v", err)
	}

	info, err := svc.Ensure(dir, "go")
	if err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	if info.State != lsp.StateRunning {
		t.Errorf("状态应为 %s，实际 %s", lsp.StateRunning, info.State)
	}
	if len(svc.Sessions()) != 1 {
		t.Errorf("应当有一个会话，实际 %d", len(svc.Sessions()))
	}
}

func TestEnsureRequiresRoot(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	if _, err := svc.Ensure("  ", "go"); err == nil {
		t.Fatal("空路径应当报错")
	}
}

// 路径写法不同（相对/带尾部斜杠）必须落到同一条信任记录上，
// 否则用户点过信任之后仍会被反复追问。
func TestTrustNormalizesPath(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	dir := t.TempDir()
	if err := svc.SetTrust(dir+string(filepath.Separator), true); err != nil {
		t.Fatalf("记录信任失败: %v", err)
	}

	state, err := svc.TrustStatus(dir)
	if err != nil {
		t.Fatalf("查询信任失败: %v", err)
	}
	if !state.Trusted {
		t.Error("带尾部斜杠写入的信任应当在标准路径上读得到")
	}
}

func TestTrustStatusDistinguishesUndecided(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	dir := t.TempDir()
	state, err := svc.TrustStatus(dir)
	if err != nil {
		t.Fatalf("查询信任失败: %v", err)
	}
	if state.Decided {
		t.Error("没问过时不应算已决定")
	}

	if err := svc.SetTrust(dir, false); err != nil {
		t.Fatalf("记录拒绝失败: %v", err)
	}
	state, err = svc.TrustStatus(dir)
	if err != nil {
		t.Fatalf("查询信任失败: %v", err)
	}
	if !state.Decided {
		t.Error("拒绝之后应当算已决定")
	}
	if state.Trusted {
		t.Error("拒绝之后不应算信任")
	}
}

// 撤销信任必须把已经跑起来的服务器一起停掉：
// 留着它是"用户说不许，但进程还在跑"，比不问更糟。
func TestRevokingTrustStopsRunningServer(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	dir := t.TempDir()
	writeFile(t, dir, "go.mod", "module example.invalid/demo\n")
	if err := svc.SetTrust(dir, true); err != nil {
		t.Fatalf("记录信任失败: %v", err)
	}
	if _, err := svc.Ensure(dir, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}

	if err := svc.SetTrust(dir, false); err != nil {
		t.Fatalf("撤销信任失败: %v", err)
	}
	if len(svc.Sessions()) != 0 {
		t.Errorf("撤销信任后会话应当被停掉，实际 %d 个", len(svc.Sessions()))
	}
}

func TestLanguageHintsCoverEveryLanguage(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	hints := svc.LanguageHints()
	if len(hints) != len(lsp.Languages) {
		t.Fatalf("应当覆盖全部 %d 种语言，实际 %d", len(lsp.Languages), len(hints))
	}
	for _, hint := range hints {
		if hint.ID == "" || hint.Server == "" {
			t.Errorf("提示缺字段: %+v", hint)
		}
		// 不静默下载二进制：装不了的时候唯一出路就是这条命令。
		if hint.InstallHint == "" {
			t.Errorf("%s 缺少安装命令", hint.ID)
		}
	}
}

func TestRestartRejectsUntrustedWorkspace(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	dir := t.TempDir()
	if _, err := svc.Restart(dir); !errors.Is(err, ErrWorkspaceUntrusted) {
		t.Fatalf("未信任的工作区不应允许重启，实际 %v", err)
	}
}

func TestStopRequiresNoTrust(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	// 停服务不该被信任状态挡住：撤销信任的路径上就要靠它收尾。
	if err := svc.Stop(t.TempDir()); !errors.Is(err, lsp.ErrSessionNotFound) {
		t.Fatalf("没有会话时应报未找到，实际 %v", err)
	}
}

// 信任绑定的是"这个目录里来自某个远端的代码"：把 remote url 改指到另一个
// 仓库之后，同一个目录里的代码就换出处了，旧的点头不该顺延。
func TestTrustInvalidatedWhenOriginChanges(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	dir := initRepo(t)
	gitIn(t, dir, "remote", "add", "origin", "https://example.invalid/acme/atlas.git")

	if err := svc.SetTrust(dir, true); err != nil {
		t.Fatalf("记录信任失败: %v", err)
	}
	state, err := svc.TrustStatus(dir)
	if err != nil {
		t.Fatalf("查询信任失败: %v", err)
	}
	if !state.Trusted || state.OriginChanged {
		t.Fatalf("同源时应当仍是信任状态，实际 %+v", state)
	}
	if state.Origin != "https://example.invalid/acme/atlas.git" {
		t.Errorf("应当记下远端来源，实际 %q", state.Origin)
	}

	gitIn(t, dir, "remote", "set-url", "origin", "https://example.invalid/other/atlas.git")
	state, err = svc.TrustStatus(dir)
	if err != nil {
		t.Fatalf("查询信任失败: %v", err)
	}
	if state.Trusted {
		t.Error("远端换了之后不该继续算信任")
	}
	if !state.Decided || !state.OriginChanged {
		t.Errorf("应当标记成'问过但来源变了'，实际 %+v", state)
	}
	if state.CurrentOrigin != "https://example.invalid/other/atlas.git" {
		t.Errorf("应当回报当前来源，实际 %q", state.CurrentOrigin)
	}
}

// 换源之后语言服务器要真的起不来，而不只是界面显示成未信任。
func TestEnsureRejectsWorkspaceAfterOriginChanges(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	dir := initRepo(t)
	writeFile(t, dir, "go.mod", "module example.invalid/demo\n")
	gitIn(t, dir, "remote", "add", "origin", "https://example.invalid/acme/atlas.git")
	if err := svc.SetTrust(dir, true); err != nil {
		t.Fatalf("记录信任失败: %v", err)
	}

	gitIn(t, dir, "remote", "set-url", "origin", "https://example.invalid/other/atlas.git")
	if _, err := svc.Ensure(dir, "go"); !errors.Is(err, ErrWorkspaceUntrusted) {
		t.Fatalf("换源之后应当拒绝启动，实际 %v", err)
	}
}

// 本地仓库没有远端，信任不该因为"找不到来源"而失效——那会让每个本地项目
// 每次打开都被再问一遍。
func TestTrustHoldsWithoutOrigin(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	dir := initRepo(t)
	if err := svc.SetTrust(dir, true); err != nil {
		t.Fatalf("记录信任失败: %v", err)
	}
	state, err := svc.TrustStatus(dir)
	if err != nil {
		t.Fatalf("查询信任失败: %v", err)
	}
	if !state.Trusted || state.OriginChanged {
		t.Errorf("没有远端的仓库应当保持信任，实际 %+v", state)
	}
}

func TestDetectLanguageFromMarkers(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	dir := t.TempDir()
	writeFile(t, dir, "go.mod", "module example.invalid/demo\n")

	got, err := svc.DetectLanguage(dir)
	if err != nil {
		t.Fatalf("探测失败: %v", err)
	}
	if !got.Found || got.ID != "go" {
		t.Errorf("应探测出 go，实际 %+v", got)
	}
	// 不静默下载二进制：探测结果必须带得出安装命令。
	if got.InstallHint == "" {
		t.Error("缺少安装命令")
	}
}

func TestDetectLanguageWithoutMarkers(t *testing.T) {
	svc, cleanup := newTestLSPService(t)
	defer cleanup()

	got, err := svc.DetectLanguage(t.TempDir())
	if err != nil {
		t.Fatalf("探测不该报错: %v", err)
	}
	if got.Found {
		t.Errorf("空目录不该探测出语言，实际 %+v", got)
	}
}
