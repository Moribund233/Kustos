//go:build !windows

package app

// webviewProfileInUse 在非 Windows 平台恒为 false：WebView2 只存在于 Windows，
// macOS 与 Linux 走各自的系统 WebView。
func webviewProfileInUse(lockfile string) bool { return false }
