package git

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"

	"github.com/kustos/kustos-desktop/internal/platform/noconsole"
)

// ErrGitMissing 表示本机没有可用的 git 可执行文件。
//
// 单独给出这个哨兵错误，是因为它和"git 跑失败了"是两件完全不同的事：
// 前者需要引导用户去装 git，后者要展示 git 自己的报错。混在一起的话，
// 界面只能说一句"克隆失败"，用户不知道该去装什么。
var ErrGitMissing = errors.New("未找到 git 可执行文件")

// Version 返回本机 git 的版本号，如 "2.55.0.windows.5"。
//
// 桌面端不内置 git，也不去猜它有没有：启动时问一次，问不到就把"需要安装
// git"这件事直接摆到界面上。等到用户点了克隆才报"exec: git not found"，
// 那时他已经选好目录、输入了地址，白做一遍。
//
// Returns:
//
//	版本号（去掉 "git version " 前缀）；找不到 git 时返回 ErrGitMissing。
func Version() (string, error) {
	path, err := exec.LookPath("git")
	if err != nil || path == "" {
		return "", ErrGitMissing
	}

	cmd := exec.Command(path, "--version")
	// 不设 cmd.Dir：版本查询与任何仓库无关，跟着进程当前目录走反而可能
	// 撞上一个已被删除的目录而失败。
	cmd.Env = gitEnv()
	noconsole.Hide(cmd)

	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git --version 失败: %w", err)
	}
	return parseGitVersion(string(out)), nil
}

// parseGitVersion 从 `git --version` 的输出里取版本号。
//
// 各平台输出略有差异（Windows 带 .windows.5，Apple 带 (Apple Git-150)），
// 统一只保留版本号本体，界面才好按需取舍显示。
func parseGitVersion(out string) string {
	fields := strings.Fields(strings.TrimSpace(out))
	if len(fields) < 3 {
		return strings.TrimSpace(out)
	}
	// 形如 "git version 2.55.0.windows.5"，第三段即版本号。
	version := fields[2]
	if idx := strings.Index(version, "("); idx >= 0 {
		version = version[:idx]
	}
	return strings.TrimSpace(version)
}
