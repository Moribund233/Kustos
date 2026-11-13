//go:build !windows

package shellreg

import "fmt"

// 非 Windows 平台不做系统集成。
//
// 这里的空实现让调用方不必写平台分支，但它们**必须报错而不是假装成功**：
// 静默成功会让界面显示"已开启"，而重启之后什么都不会发生。真正的实现
// 在各自的打包阶段（Linux 的 .desktop、macOS 的 plist + open），那时这些
// 函数才会被填上。

// RegisterProtocol 在非 Windows 平台不可用。
func RegisterProtocol(scheme, exePath string) error {
	return fmt.Errorf("当前平台不支持注册 %s:// 协议", scheme)
}

// UnregisterProtocol 在非 Windows 平台不可用。
func UnregisterProtocol(scheme string) error {
	return fmt.Errorf("当前平台不支持注册 %s:// 协议", scheme)
}

// ProtocolRegistered 在非 Windows 平台恒为 false。
func ProtocolRegistered(scheme, exePath string) bool {
	return false
}

// SetAutostart 在非 Windows 平台不可用。
func SetAutostart(enabled bool, exePath string) error {
	return fmt.Errorf("当前平台不支持开机自启")
}

// AutostartEnabled 在非 Windows 平台恒为 false。
func AutostartEnabled(exePath string) bool {
	return false
}
