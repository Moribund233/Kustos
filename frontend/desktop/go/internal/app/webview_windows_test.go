//go:build windows

package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// 旧实例没退干净时 WebView2 目录还被占着：必须等、等不到就报可读的错误，
// 而不是让 Wails 在 controller 创建处以 0x800700AA 直接退出。
func TestWaitWebviewProfileWhileLocked(t *testing.T) {
	dir := t.TempDir()
	lockfile := filepath.Join(dir, "EBWebView", "lockfile")
	if err := os.MkdirAll(filepath.Dir(lockfile), 0o700); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(lockfile, nil, 0o600); err != nil {
		t.Fatalf("建 lockfile 失败: %v", err)
	}

	p, err := windows.UTF16PtrFromString(lockfile)
	if err != nil {
		t.Fatalf("路径转换失败: %v", err)
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil,
		windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("独占打开失败: %v", err)
	}

	if err := waitWebviewProfile(dir, 300*time.Millisecond); err == nil {
		t.Fatal("被占用时应返回错误")
	}

	_ = windows.CloseHandle(h)
	if err := waitWebviewProfile(dir, 300*time.Millisecond); err != nil {
		t.Fatalf("释放后应通过: %v", err)
	}
}

// 没有 lockfile（从未启动过或上次正常退出）时立即通过，不该白白等 5 秒。
func TestWaitWebviewProfileWhenFree(t *testing.T) {
	if err := waitWebviewProfile(t.TempDir(), 5*time.Second); err != nil {
		t.Fatalf("空闲目录应通过: %v", err)
	}
}
