//go:build windows

package git

import (
	"errors"
	"syscall"
)

// isWindowsAccessDenied 判断错误是不是 Windows 的 ERROR_ACCESS_DENIED。
//
// 不用 `os.ErrPermission` 一条条比对：`os.MkdirAll` 在 Windows 上返回的是
// `*os.PathError` 包着的 `syscall.Errno(5)`，它在部分 Go 版本里**不**等于
// `os.ErrPermission`，只靠 `errors.Is(err, os.ErrPermission)` 会漏判。
func isWindowsAccessDenied(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	return errno == syscall.ERROR_ACCESS_DENIED
}
