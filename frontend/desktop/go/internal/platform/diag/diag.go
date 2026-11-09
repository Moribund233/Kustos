// Package diag 负责桌面端启动期的诊断输出。
//
// GUI 构建没有控制台：启动失败只写 stderr 等于什么都没说，用户只看到"闪退"。
// 这里把日志落到数据目录，并在致命错误时弹窗告知原因。
package diag

import (
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"path/filepath"
)

// logName 是启动日志文件名，与 kustos.db 同级，排查时只需看一个地方。
const logName = "desktop.log"

// logPath 是当前会话的日志路径，供弹窗告诉用户去哪儿看详情。
var logPath string

// Setup 打开启动日志，并把标准库日志与 Wails 系统日志都指过去。
//
// Args:
//
//	dir: 数据目录（与本地库同级）
//
// Returns:
//
//	Wails 用的 slog 记录器；打开失败时返回 nil 与错误，调用方应继续启动。
func Setup(dir string) (*slog.Logger, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("创建日志目录失败: %w", err)
	}
	p := filepath.Join(dir, logName)
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("打开日志文件失败: %w", err)
	}
	logPath = p
	// 同时写 stderr：从终端启动时仍能直接看到，不必去翻文件。
	out := io.MultiWriter(os.Stderr, f)
	log.SetOutput(out)
	return slog.New(slog.NewTextHandler(out, nil)), nil
}

// Fatalf 记录致命错误、弹窗告知原因，然后以 1 退出。
//
// 不返回：调用方在启动路径上，出错后继续执行只会得到更晚、更难读的失败。
func Fatalf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Print(msg)
	if logPath != "" {
		msg += "\n\n日志: " + logPath
	}
	showMessage("Kustos 启动失败", msg)
	os.Exit(1)
}
