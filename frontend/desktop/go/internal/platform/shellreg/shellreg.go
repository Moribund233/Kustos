// Package shellreg 负责 Windows 上的"系统集成"注册项：深链协议与开机自启。
//
// 这两件事都写用户的 HKCU，而不是 HKLM：桌面端是按用户安装的普通程序，
// 写 HKLM 需要管理员权限，而"装个编辑器还要弹一次 UAC"会让人直接放弃。
//
// 与其它 platform 包一样，非 Windows 平台提供同签名的空实现：调用方不需要
// 为平台差异写分支，而 Linux/macOS 上"注册协议"本来另有做法（.desktop / plist），
// 那是发布打包阶段的事，不在本包假装支持。
package shellreg

// Scheme 是深链协议名，与 internal/platform/deeplink 的 Scheme 一致。
const Scheme = "kustos"

// RunValueName 是开机自启在 Run 键下的值名。
//
// 取产品名而不是可执行文件名：用户会在任务管理器的启动项里看到它，
// "kustos-desktop" 与 "Kustos" 后者才是他能认出来的那个。
const RunValueName = "Kustos"

// ProtocolCommand 把可执行文件路径拼成协议处理命令。
//
// Args:
//
//	exePath: 可执行文件的绝对路径
//
// Returns:
//
//	形如 `"C:\path\kustos-desktop.exe" "%1"` 的命令行。
//
// 两处引号都不能省：可执行文件路径含空格（Program Files、用户名含空格）时，
// 不加引号会被拆成多个参数；`%1` 不加引号则让浏览器传来的 URL 里含空格时
// 同样被拆开。这两个引号是 Windows 注册协议处理器的既定写法。
func ProtocolCommand(exePath string) string {
	return `"` + exePath + `" "%1"`
}

// AutostartCommand 把可执行文件路径拼成开机自启命令。
//
// Args:
//
//	exePath: 可执行文件的绝对路径
//
// Returns:
//
//	加了引号的可执行文件路径（不带参数：自启动不需要深链）。
func AutostartCommand(exePath string) string {
	return `"` + exePath + `"`
}
