package lsp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// 假语言服务器跑在测试进程自己的副本里。
//
// 真实的 gopls / tsserver 既不是每台机器都有，行为也不受控；这一层要验证的是
// 进程生命周期（拉起、转发、崩溃、退避重启、回收），用一条行为确定的假进程
// 才能把"崩溃三次后放弃"这类分支测出来。
const fakeServerEnv = "KUSTOS_FAKE_LSP_MODE"

// fakeMarkerEnv 指向一个标记文件，用于"只崩第一次"这类场景。
const fakeMarkerEnv = "KUSTOS_FAKE_LSP_MARKER"

// TestFakeServerProcess 在设置了环境变量时充当假服务器；正常测试运行时被跳过。
func TestFakeServerProcess(t *testing.T) {
	mode := os.Getenv(fakeServerEnv)
	if mode == "" {
		t.Skip("不是假服务器进程")
	}
	switch mode {
	case "echo":
		runEcho()
	case "crash-now":
		fmt.Fprintln(os.Stderr, "假服务器启动即退出")
		os.Exit(3)
	case "crash-once-after-frame":
		crashOnceAfterFirstFrame()
	case "crash-after-delay":
		time.Sleep(30 * time.Millisecond)
		fmt.Fprintln(os.Stderr, "假服务器定时崩溃")
		os.Exit(3)
	default:
		fmt.Fprintf(os.Stderr, "未知的假服务器模式: %s\n", mode)
		os.Exit(2)
	}
	// 直接退出而不是让测试框架收尾：框架会往 stdout 打 "PASS"，那会混进
	// 帧流里，让被测的解析代码收到半截头。
	os.Exit(0)
}

// runEcho 把收到的每一帧原样回写。
func runEcho() {
	r := bufio.NewReader(os.Stdin)
	for {
		body, err := ReadFrame(r)
		if err != nil {
			return
		}
		if err := WriteFrame(os.Stdout, body); err != nil {
			return
		}
	}
}

// crashOnceAfterFirstFrame 用标记文件实现"第一次崩、之后正常"。
func crashOnceAfterFirstFrame() {
	marker := os.Getenv(fakeMarkerEnv)
	r := bufio.NewReader(os.Stdin)
	body, err := ReadFrame(r)
	if err != nil {
		return
	}
	if _, statErr := os.Stat(marker); statErr != nil {
		_ = os.WriteFile(marker, []byte("crashed"), 0o600)
		fmt.Fprintln(os.Stderr, "假服务器第一次崩溃")
		os.Exit(3)
	}
	_ = WriteFrame(os.Stdout, body)
	runEcho()
}

// newFakePool 构造一个所有会话都用假服务器模式运行的进程池。
//
// 不在这里注册 t.Cleanup：临时目录的清理是 LIFO 的，池的关闭必须早于
// 目录删除（假进程以工作区为 cwd，Windows 上句柄没释放就删不掉），所以由
// 调用方用 defer 保证顺序。
func newFakePool(t *testing.T, mode string, opts Options) *Pool {
	t.Helper()
	if opts.Command == nil {
		opts.Command = func(ctx context.Context, name string, args ...string) *exec.Cmd {
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=TestFakeServerProcess")
			cmd.Env = append(os.Environ(), fakeServerEnv+"="+mode)
			return cmd
		}
	}
	if opts.Resolve == nil {
		opts.Resolve = func(Language) (string, bool) { return os.Args[0], true }
	}
	return NewPool(opts)
}

// tempWorkspace 造一个带 go.mod 的工作区（Go 是探测表里 marker 最简单的语言）。
func tempWorkspace(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module example.invalid/demo\n"), 0o600); err != nil {
		t.Fatalf("写 go.mod 失败: %v", err)
	}
	return dir
}

// waitFor 轮询直到条件成立或超时。
func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等待超时（%s）: %s", timeout, what)
}

// drain 读完连接上的一条消息。
func drain(t *testing.T, conn *Conn, timeout time.Duration) []byte {
	t.Helper()
	select {
	case body, ok := <-conn.Frames():
		if !ok {
			t.Fatalf("消息通道已关闭")
		}
		return body
	case <-time.After(timeout):
		t.Fatalf("等待服务器消息超时")
		return nil
	}
}

func TestEnsureRejectsMissingWorkspace(t *testing.T) {
	p := newFakePool(t, "echo", Options{})
	defer p.Close()

	_, err := p.Ensure(filepath.Join(t.TempDir(), "nope"), "go")
	if err == nil {
		t.Fatal("工作区不存在时应当报错")
	}
}

func TestEnsureRejectsUnknownLanguage(t *testing.T) {
	p := newFakePool(t, "echo", Options{})
	defer p.Close()

	_, err := p.Ensure(tempWorkspace(t), "cobol")
	if err == nil {
		t.Fatal("未知语言应当报错")
	}
}

func TestEnsureReportsMissingServer(t *testing.T) {
	p := NewPool(Options{Resolve: func(Language) (string, bool) { return "", false }})
	defer p.Close()

	_, err := p.Ensure(tempWorkspace(t), "go")
	if !errors.Is(err, ErrServerMissing) {
		t.Fatalf("应当返回 ErrServerMissing，实际 %v", err)
	}
}

func TestEnsureStartsProcessAndForwardsFrames(t *testing.T) {
	p := newFakePool(t, "echo", Options{})
	defer p.Close()
	root := tempWorkspace(t)

	info, err := p.Ensure(root, "go")
	if err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	if info.State != StateRunning {
		t.Errorf("状态应为 %s，实际 %s", StateRunning, info.State)
	}
	if info.Language != "go" {
		t.Errorf("语言应为 go，实际 %s", info.Language)
	}

	conn, err := p.Attach(root)
	if err != nil {
		t.Fatalf("Attach 失败: %v", err)
	}
	defer conn.Close()

	payload := `{"jsonrpc":"2.0","id":1,"method":"initialize"}`
	if err := conn.Send([]byte(payload)); err != nil {
		t.Fatalf("Send 失败: %v", err)
	}
	if got := string(drain(t, conn, 2*time.Second)); got != payload {
		t.Errorf("回显不一致:\n want %s\n got  %s", payload, got)
	}
}

func TestEnsureIsIdempotent(t *testing.T) {
	p := newFakePool(t, "echo", Options{})
	defer p.Close()
	root := tempWorkspace(t)

	first, err := p.Ensure(root, "go")
	if err != nil {
		t.Fatalf("第一次 Ensure 失败: %v", err)
	}
	second, err := p.Ensure(root, "go")
	if err != nil {
		t.Fatalf("第二次 Ensure 失败: %v", err)
	}
	if first.StartedAt != second.StartedAt {
		t.Errorf("重复 Ensure 不应重拉进程: %d != %d", first.StartedAt, second.StartedAt)
	}
	if len(p.Sessions()) != 1 {
		t.Errorf("会话数应为 1，实际 %d", len(p.Sessions()))
	}
}

func TestEnsureDetectsLanguageFromMarkers(t *testing.T) {
	p := newFakePool(t, "echo", Options{})
	defer p.Close()

	info, err := p.Ensure(tempWorkspace(t), "")
	if err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	if info.Language != "go" {
		t.Errorf("应当探测出 go，实际 %s", info.Language)
	}
}

func TestEnsureRejectsWorkspaceWithoutMarkers(t *testing.T) {
	p := newFakePool(t, "echo", Options{})
	defer p.Close()

	_, err := p.Ensure(t.TempDir(), "")
	if err == nil {
		t.Fatal("没有 marker 时应当报错")
	}
}

func TestEnsureEnforcesSessionLimit(t *testing.T) {
	p := newFakePool(t, "echo", Options{MaxSessions: 2})
	defer p.Close()

	for i := 0; i < 2; i++ {
		if _, err := p.Ensure(tempWorkspace(t), "go"); err != nil {
			t.Fatalf("第 %d 个会话应当成功: %v", i+1, err)
		}
	}
	_, err := p.Ensure(tempWorkspace(t), "go")
	if !errors.Is(err, ErrTooManySessions) {
		t.Fatalf("应当返回 ErrTooManySessions，实际 %v", err)
	}
}

func TestAttachRejectsSecondClient(t *testing.T) {
	p := newFakePool(t, "echo", Options{})
	defer p.Close()
	root := tempWorkspace(t)
	if _, err := p.Ensure(root, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	conn, err := p.Attach(root)
	if err != nil {
		t.Fatalf("第一次 Attach 失败: %v", err)
	}
	defer conn.Close()

	if _, err := p.Attach(root); !errors.Is(err, ErrAlreadyAttached) {
		t.Fatalf("应当返回 ErrAlreadyAttached，实际 %v", err)
	}
}

func TestAttachWithoutSession(t *testing.T) {
	p := newFakePool(t, "echo", Options{})
	defer p.Close()

	if _, err := p.Attach(t.TempDir()); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("应当返回 ErrSessionNotFound，实际 %v", err)
	}
}

func TestSessionsSortedByStartTime(t *testing.T) {
	p := newFakePool(t, "echo", Options{})
	defer p.Close()
	first := tempWorkspace(t)
	second := tempWorkspace(t)
	if _, err := p.Ensure(first, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	time.Sleep(5 * time.Millisecond)
	if _, err := p.Ensure(second, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}

	list := p.Sessions()
	if len(list) != 2 {
		t.Fatalf("会话数应为 2，实际 %d", len(list))
	}
	if list[0].Root != first {
		t.Errorf("最早的会话应排第一，实际 %s", list[0].Root)
	}
}

func TestStopRemovesSession(t *testing.T) {
	p := newFakePool(t, "echo", Options{})
	defer p.Close()
	root := tempWorkspace(t)
	if _, err := p.Ensure(root, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	if err := p.Stop(root); err != nil {
		t.Fatalf("Stop 失败: %v", err)
	}
	if len(p.Sessions()) != 0 {
		t.Errorf("会话应当已被移除")
	}
	if err := p.Stop(root); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("重复 Stop 应返回 ErrSessionNotFound，实际 %v", err)
	}
}

func TestRestartRelaunchesProcess(t *testing.T) {
	p := newFakePool(t, "echo", Options{})
	defer p.Close()
	root := tempWorkspace(t)
	before, err := p.Ensure(root, "go")
	if err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	after, err := p.Restart(root)
	if err != nil {
		t.Fatalf("Restart 失败: %v", err)
	}
	if after.StartedAt == before.StartedAt {
		t.Error("重启后启动时间应当变化")
	}
	if after.State != StateRunning {
		t.Errorf("重启后状态应为 %s，实际 %s", StateRunning, after.State)
	}

	conn, err := p.Attach(root)
	if err != nil {
		t.Fatalf("重启后 Attach 失败: %v", err)
	}
	defer conn.Close()
	if err := conn.Send([]byte(`{"id":1}`)); err != nil {
		t.Fatalf("Send 失败: %v", err)
	}
	if got := string(drain(t, conn, 2*time.Second)); got != `{"id":1}` {
		t.Errorf("回显不一致: %s", got)
	}
}

func TestCrashWithoutClientDropsSession(t *testing.T) {
	p := newFakePool(t, "crash-now", Options{})
	defer p.Close()
	root := tempWorkspace(t)
	if _, err := p.Ensure(root, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	waitFor(t, 2*time.Second, "崩溃的会话被摘掉", func() bool { return len(p.Sessions()) == 0 })
}

func TestCrashWithClientRestartsAndRecovers(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "crashed")
	t.Setenv(fakeMarkerEnv, marker)

	p := newFakePool(t, "crash-once-after-frame", Options{RestartDelays: []time.Duration{10 * time.Millisecond}})
	defer p.Close()
	root := tempWorkspace(t)
	if _, err := p.Ensure(root, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}

	conn, err := p.Attach(root)
	if err != nil {
		t.Fatalf("Attach 失败: %v", err)
	}
	if err := conn.Send([]byte(`{"id":1}`)); err != nil {
		t.Fatalf("Send 失败: %v", err)
	}
	// 第一代进程读到一帧后崩溃；标记文件由它自己创建，所以这里只管等。
	waitFor(t, 3*time.Second, "进程重启并恢复运行", func() bool {
		for _, s := range p.Sessions() {
			if s.State == StateRunning && s.Restarts >= 1 {
				return true
			}
		}
		return false
	})

	// 旧连接随崩溃失效（attached 已清），重连就能继续用新进程。
	fresh, err := p.Attach(root)
	if err != nil {
		t.Fatalf("重启后 Attach 失败: %v", err)
	}
	defer fresh.Close()
	if err := fresh.Send([]byte(`{"id":2}`)); err != nil {
		t.Fatalf("重连后 Send 失败: %v", err)
	}
	if got := string(drain(t, fresh, 2*time.Second)); got != `{"id":2}` {
		t.Errorf("重连后回显不一致: %s", got)
	}
}

func TestRepeatedCrashesGiveUp(t *testing.T) {
	delays := []time.Duration{10 * time.Millisecond, 10 * time.Millisecond}
	p := newFakePool(t, "crash-after-delay", Options{RestartDelays: delays})
	defer p.Close()
	root := tempWorkspace(t)
	if _, err := p.Ensure(root, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	conn, err := p.Attach(root)
	if err != nil {
		t.Fatalf("Attach 失败: %v", err)
	}
	defer conn.Close()

	waitFor(t, 5*time.Second, "重试用尽后进入 failed", func() bool {
		list := p.Sessions()
		return len(list) == 1 && list[0].State == StateFailed
	})
	info := p.Sessions()[0]
	if info.Restarts != len(delays) {
		t.Errorf("重启次数应为 %d，实际 %d", len(delays), info.Restarts)
	}
	if info.LastError == "" {
		t.Error("failed 状态应当带上原因")
	}
	if _, err := p.Attach(root); err == nil {
		t.Fatal("已放弃重启的会话不应允许再连")
	}
}

func TestConnCloseStopsSession(t *testing.T) {
	p := newFakePool(t, "echo", Options{})
	defer p.Close()
	root := tempWorkspace(t)
	if _, err := p.Ensure(root, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	conn, err := p.Attach(root)
	if err != nil {
		t.Fatalf("Attach 失败: %v", err)
	}
	conn.Close()
	if len(p.Sessions()) != 0 {
		t.Error("断开连接后会话应当被回收")
	}
	select {
	case <-conn.Closed():
	default:
		t.Error("Closed 通道应当已关闭")
	}
}

func TestIdleSessionIsCollected(t *testing.T) {
	p := newFakePool(t, "echo", Options{IdleTimeout: 30 * time.Millisecond})
	defer p.Close()
	root := tempWorkspace(t)
	if _, err := p.Ensure(root, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	waitFor(t, 2*time.Second, "空闲会话被回收", func() bool { return len(p.Sessions()) == 0 })
}

func TestAttachedSessionSurvivesIdleTimeout(t *testing.T) {
	p := newFakePool(t, "echo", Options{IdleTimeout: 30 * time.Millisecond})
	defer p.Close()
	root := tempWorkspace(t)
	if _, err := p.Ensure(root, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	conn, err := p.Attach(root)
	if err != nil {
		t.Fatalf("Attach 失败: %v", err)
	}
	defer conn.Close()

	time.Sleep(120 * time.Millisecond)
	if len(p.Sessions()) != 1 {
		t.Error("有客户端的会话不应被空闲回收")
	}
}
