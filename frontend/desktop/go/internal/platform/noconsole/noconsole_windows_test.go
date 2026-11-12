//go:build windows

package noconsole

import (
	"os/exec"
	"syscall"
	"testing"
)

// 这里只测**标志位有没有设对**，不启动任何进程。
//
// 真实效果（窗口真的不闪）只能在带 GUI 的环境里肉眼验，但那正是回归时
// 最容易忘的一步——把"标志位在不在"钉死，至少能挡住有人不小心删掉这层。

func TestHideSetsWindowFlags(t *testing.T) {
	cmd := exec.Command("git", "--version")

	Hide(cmd)

	if cmd.SysProcAttr == nil {
		t.Fatal("Hide 之后 SysProcAttr 不应为空")
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Error("HideWindow 应为 true")
	}
	if cmd.SysProcAttr.CreationFlags&createNoWindow == 0 {
		t.Errorf("CreationFlags 应含 CREATE_NO_WINDOW，实际 %#x", cmd.SysProcAttr.CreationFlags)
	}
}

func TestHideKeepsExistingAttrs(t *testing.T) {
	// 调用方可能已经设了自己的 SysProcAttr，不能整个替换掉。
	cmd := exec.Command("git", "--version")
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000010}

	Hide(cmd)

	if cmd.SysProcAttr == nil {
		t.Fatal("SysProcAttr 被清空了")
	}
	if cmd.SysProcAttr.CreationFlags&0x00000010 == 0 {
		t.Error("调用方原有的创建标志被覆盖了")
	}
	if cmd.SysProcAttr.CreationFlags&createNoWindow == 0 {
		t.Error("应在已有标志上追加 CREATE_NO_WINDOW")
	}
}

func TestHideNilCommand(t *testing.T) {
	// nil 不应 panic：调用方在错误分支里可能忘了判断。
	Hide(nil)
}
