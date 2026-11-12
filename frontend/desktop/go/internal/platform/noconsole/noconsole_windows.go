//go:build windows

package noconsole

import (
	"os/exec"
	"syscall"
)

// createNoWindow 是 CreateProcess 的 CREATE_NO_WINDOW 标志。
//
// 与 HideWindow 的区别：HideWindow 只是让窗口以隐藏方式创建（仍然创建），
// CREATE_NO_WINDOW 压根不创建控制台。对于 GUI 子系统父进程拉起的控制台
// 程序，两者都能止住闪屏，一起给上最稳妥。
const createNoWindow = 0x08000000

// hide 给子进程加上"不要控制台窗口"的创建标志。
func hide(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}
