package app

import (
	"fmt"
	"path/filepath"
	"time"
)

// webviewProfileName 是 WebView2 用户数据目录在本机数据目录下的名字。
//
// 不用 Wails 的默认值（%APPDATA%\<exe 名>）：那个目录叫 kustos-desktop.exe，
// 像文件不像目录，且所有实例、所有版本共用一份，出问题无从隔离。
const webviewProfileName = "webview2"

// webviewProfileWait 是启动时等旧实例放开 WebView2 用户数据目录的上限。
//
// 上一个进程被杀后 lockfile 还会被占用一小会儿；此时创建 controller 会返回
// 0x800700AA，而 Wails 把这类错误当致命错误直接退出（见 edge.Chromium.Embed）。
const webviewProfileWait = 5 * time.Second

// waitWebviewProfile 等 WebView2 的用户数据目录空出来。
//
// 必须在单实例判定之后调用（application.New 内部完成判定，第二个实例此时
// 已退出），否则会把"自己就是第二个实例"误判成目录被占用。
//
// Args:
//
//	dir: WebView2 用户数据目录
//	budget: 最长等待时间
//
// Returns:
//
//	目录可用时返回 nil；超时仍被占用时返回带处理建议的错误。
func waitWebviewProfile(dir string, budget time.Duration) error {
	lockfile := filepath.Join(dir, "EBWebView", "lockfile")
	deadline := time.Now().Add(budget)
	for webviewProfileInUse(lockfile) {
		if time.Now().After(deadline) {
			return fmt.Errorf(
				"WebView2 用户数据目录仍被占用（%s）：可能还有一个 Kustos 进程没有退出，请先关掉它或稍后重试",
				lockfile,
			)
		}
		time.Sleep(200 * time.Millisecond)
	}
	return nil
}
