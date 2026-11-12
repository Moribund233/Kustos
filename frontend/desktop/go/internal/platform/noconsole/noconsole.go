// Package noconsole 让子进程启动时不弹出控制台窗口。
//
// 桌面端是 GUI 子系统进程，没有自己的控制台。Windows 上给这种进程拉起
// 控制台程序（git、语言服务器、rundll32 之类）时，系统会为子进程新建一个
// 控制台窗口——于是每跑一次 git 就闪一次黑框。状态轮询与逐行 diff 都会
// 频繁触发，闪屏会直接毁掉使用体验。
//
// 用法是构造完 *exec.Cmd 后调一次 Hide 再 Start/Run，不要自己摸
// SysProcAttr：非 Windows 平台上那些字段根本不存在。
package noconsole

import "os/exec"

// Hide 让 cmd 启动时不显示控制台窗口。
//
// 非 Windows 平台上它是空操作——那里没有"控制台窗口"这回事，
// 子进程继承调用方的终端。
func Hide(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	hide(cmd)
}
