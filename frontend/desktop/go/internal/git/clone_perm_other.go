//go:build !windows

package git

// isWindowsAccessDenied 在非 Windows 上恒为 false：`os.ErrPermission` 已经
// 覆盖了那些平台的权限错误。
func isWindowsAccessDenied(error) bool {
	return false
}
