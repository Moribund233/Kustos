//go:build windows

package diag

import (
	"os"
	"syscall"
	"unsafe"
)

// noDialogEnv 关闭弹窗：CI/自动化里没人点它，进程会被一直卡住。
const noDialogEnv = "KUSTOS_DESKTOP_NO_DIALOG"

// showMessage 用系统模态框把启动失败原因告诉用户。
func showMessage(title, text string) {
	if os.Getenv(noDialogEnv) != "" {
		return
	}
	t, err := syscall.UTF16PtrFromString(text)
	if err != nil {
		return
	}
	c, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	// MB_ICONERROR：与"启动失败"的语气一致，用户能直接看到红叉。
	syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(
		0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x10,
	)
}
