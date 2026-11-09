//go:build windows

package store

import (
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// 文件被别的进程独占时只重试、不隔离：把正在被使用的库改名等于在用户脚下抽地板。
func TestOpenDoesNotQuarantineLockedFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "kustos.db")

	db, err := Open(path)
	if err != nil {
		t.Fatalf("建库失败: %v", err)
	}
	_ = db.Close()

	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatalf("路径转换失败: %v", err)
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil,
		windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("独占打开失败: %v", err)
	}
	defer func() { _ = windows.CloseHandle(h) }()

	oldDelay := openRetryDelay
	openRetryDelay = time.Millisecond
	t.Cleanup(func() { openRetryDelay = oldDelay })

	if _, err := Open(path); err == nil {
		t.Fatal("库被独占时应返回错误")
	}

	matches, err := filepath.Glob(path + ".corrupt-*")
	if err != nil {
		t.Fatalf("查找隔离文件失败: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("被占用的库不应被隔离，实际产生了 %v", matches)
	}
}
