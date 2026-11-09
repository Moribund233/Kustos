//go:build !windows

package diag

// showMessage 在非 Windows 平台只保留日志：桌面环境从终端启动能看到原因。
func showMessage(title, text string) {}
