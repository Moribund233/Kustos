//go:build !windows

package noconsole

import "os/exec"

// hide 在非 Windows 平台是空操作。
//
// 子进程继承调用方的终端或直接没有终端，不存在"额外弹一个控制台窗口"。
func hide(cmd *exec.Cmd) {
	_ = cmd
}
