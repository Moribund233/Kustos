//go:build windows

package app

import (
	"errors"

	"golang.org/x/sys/windows"
)

// webviewProfileInUse 判断 WebView2 的 lockfile 是否被别的进程持有。
//
// 以"拒绝一切共享"的方式打开：WebView2 运行期间一直持有这个文件，任何
// 共享打开都会失败；没人持有时打开成功。这里不能用 os.OpenFile——Go 默认
// 允许共享，占用检测不到。
func webviewProfileInUse(lockfile string) bool {
	p, err := windows.UTF16PtrFromString(lockfile)
	if err != nil {
		return false
	}
	h, err := windows.CreateFile(
		p,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		0, // 不共享
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err == nil {
		_ = windows.CloseHandle(h)
		return false
	}
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
		errors.Is(err, windows.ERROR_ACCESS_DENIED)
}
