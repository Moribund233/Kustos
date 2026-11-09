package app

import (
	"os"
	"strconv"
	"strings"
)

// cdpEnvVar 是开启远程调试的环境变量。
//
// 取值是该变量里给出的端口号，例如 `KUSTOS_DESKTOP_CDP_PORT=9222`。
const cdpEnvVar = "KUSTOS_DESKTOP_CDP_PORT"

// debugCDPPort 返回要为 WebView2 打开的远程调试端口；未启用时返回 0。
//
// 为什么用环境变量而不是配置项或命令行开关：
//
//	WebView2 的 `--remote-debugging-port` 会把**整个渲染进程**交给任何能连上
//	该端口的人——能读页面、能执行任意 JS，而桌面端的 JS 手里有 access token。
//	这样的能力不该出现在分发给团队成员的产物里，也不该有一个"配置里能打开"
//	的常驻入口。环境变量只在当前进程的启动环境里存在，发布版默认完全没有
//	这条路；要调试的人自己显式给出。
//
// 同时刻意不给它一条"开着但只绑回环就安全"的说法：CDP 协议本身不校验来源，
// 本机任意进程都能连。因此这里只在调试时用，用完即撤。
//
// Returns:
//
//	可用的端口号；未设置、非法或超出范围时返回 0（静默关闭，
//	不让一个笔误把应用变成启动失败）。
func debugCDPPort() int {
	raw := strings.TrimSpace(os.Getenv(cdpEnvVar))
	if raw == "" {
		return 0
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port <= 0 || port > 65535 {
		return 0
	}
	return port
}

// browserArgs 返回要透传给 WebView2 的浏览器参数。
//
// WebView2 的浏览器参数是**进程级**的（所有窗口共享一个浏览器环境），
// 因此只能在创建应用时一次性给出，不能按窗口设置。
//
// Returns:
//
//	参数列表；未启用远程调试时返回 nil。
func browserArgs() []string {
	port := debugCDPPort()
	if port == 0 {
		return nil
	}
	return []string{"--remote-debugging-port=" + strconv.Itoa(port)}
}
