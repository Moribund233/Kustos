// Package deeplink 解析 `kustos://` 深链。
//
// 深链是"从系统别处把桌面端叫起来并直接落到某一屏"的唯一入口：浏览器里的
// 通知、外部的脚本、安装器都可以发一条 URL。它同时是**跨信任边界**的输入——
// 任何本机进程都能伪造一条深链，因此这里只做严格形状校验，解析结果只有
// 有限几种，绝不把 URL 里的任意文本原样变成一次动作。
//
// 刻意不支持的形态：
//   - 任意路径或方法：深链不是 RPC，能做的事只有"打开某一屏"；
//   - 外部主机：`kustos://evil.example/x` 与 `kustos://x` 不该等价，
//     非空 host 一律拒绝，免得将来有人把它当成可配地址。
package deeplink

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// Scheme 是深链的协议名。
const Scheme = "kustos"

// Target 是深链指向的目标。
type Target struct {
	// Surface 是要切换到的界面分区：inbox / working-copy / code / pull-requests / issues。
	Surface string
	// Review 非空表示还要打开评审窗，值是 `仓库 id|PR 编号`。
	//
	// 带仓库 id 是因为 PR 编号只在仓库内唯一：只带编号会把 A 仓库的 #3
	// 打开成 B 仓库的 #3。
	Review string
}

// surfaces 是深链允许落到的分区白名单。
//
// 白名单而不是透传：这些字符串会进前端的路由判定，透传等于把"能跳到哪里"
// 交给发链方决定。值必须与前端 `shell.tsx` 里的 Surface 标识逐字一致——
// 两处各写一套，深链会安静地落到不存在的分区。
var surfaces = map[string]bool{
	"inbox":        true,
	"working-copy": true,
	"code":         true,
	"pulls":        true,
	"issues":       true,
}

// Parse 解析一条深链。
//
// Args:
//
//	raw: 完整 URL，如 `kustos://code`、`kustos://review/01abc|42`
//
// Returns:
//
//	解析出的目标；形状不合法时返回错误。
//
// 不合法一律返回错误而不是回落到默认屏：一条打不开的深链应当让调用方知道，
// 悄悄打开 Inbox 会让人以为链接生效了。
func Parse(raw string) (Target, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return Target{}, fmt.Errorf("深链为空")
	}

	u, err := url.Parse(trimmed)
	if err != nil {
		return Target{}, fmt.Errorf("深链不是合法 URL: %w", err)
	}
	if u.Scheme != Scheme {
		return Target{}, fmt.Errorf("深链协议必须是 %s，实际 %q", Scheme, u.Scheme)
	}
	// 查询串与片段都不参与：深链的语义全在路径里，多出来的部分视为拼错。
	if u.RawQuery != "" || u.Fragment != "" {
		return Target{}, fmt.Errorf("深链不接受查询串或片段")
	}

	// `kustos://code` 的 `code` 落在 Host 里：Go 对非特殊协议不做主机/路径
	// 的语义区分，第一段就是 Host。因此把 Host 当成路径首段接回去，形状校验
	// 仍由后面的白名单统一裁决——`kustos://evil.example/code` 会因首段不是
	// 已知目标而被拒，不需要额外的主机判断。
	segments := splitPath(u.Path)
	if u.Host != "" {
		segments = append([]string{u.Host}, segments...)
	}
	if len(segments) == 0 {
		return Target{}, fmt.Errorf("深链缺少目标")
	}

	switch segments[0] {
	case "review":
		return parseReview(segments)
	default:
		if !surfaces[segments[0]] {
			return Target{}, fmt.Errorf("未知的深链目标: %q", segments[0])
		}
		if len(segments) > 1 {
			return Target{}, fmt.Errorf("分区深链不接受额外路径: %q", strings.Join(segments[1:], "/"))
		}
		return Target{Surface: segments[0]}, nil
	}
}

// parseReview 解析 `kustos://review/<仓库 id>|<PR 编号>`。
func parseReview(segments []string) (Target, error) {
	if len(segments) != 2 {
		return Target{}, fmt.Errorf("评审深链需要 `仓库 id|PR 编号` 一段，实际 %d 段", len(segments))
	}
	// Path 里的 `|` 会被 url.Parse 保留，不需要解码；但 `%7C` 得还原。
	value := segments[1]
	if unescaped, err := url.QueryUnescape(value); err == nil {
		value = unescaped
	}
	repoID, number, ok := strings.Cut(value, "|")
	if !ok {
		return Target{}, fmt.Errorf("评审深链缺少分隔符: %q", value)
	}
	repoID = strings.TrimSpace(repoID)
	if repoID == "" {
		return Target{}, fmt.Errorf("评审深链缺少仓库 id")
	}
	// 编号必须是正整数：它会被直接放进 `#/review/...` 片段，非数字没有任何意义。
	n, err := strconv.Atoi(strings.TrimSpace(number))
	if err != nil || n <= 0 {
		return Target{}, fmt.Errorf("评审编号必须是正整数: %q", number)
	}
	return Target{Surface: "pulls", Review: fmt.Sprintf("%s|%d", repoID, n)}, nil
}

// splitPath 把路径切成非空段。
func splitPath(path string) []string {
	raw := strings.Split(strings.Trim(path, "/"), "/")
	out := make([]string, 0, len(raw))
	for _, segment := range raw {
		if segment == "" {
			continue
		}
		out = append(out, segment)
	}
	return out
}

// FindInArgs 从一组命令行参数里挑出第一条深链。
//
// Args:
//
//	args: 完整命令行参数（第 0 个是程序自身路径）
//
// Returns:
//
//	找到的深链原文与 true；没有时为 false。
//
// 跳过第 0 个参数：Windows 注册表里 `"C:\...\kustos-desktop.exe" "%1"` 展开后
// 程序路径排在首位，而它本身永远不是用户意图。
func FindInArgs(args []string) (string, bool) {
	for index, arg := range args {
		if index == 0 {
			continue
		}
		trimmed := strings.TrimSpace(arg)
		if strings.HasPrefix(strings.ToLower(trimmed), Scheme+"://") {
			return trimmed, true
		}
	}
	return "", false
}
