// Package shellopen 把"用系统默认程序打开某个东西"收敛到一处。
//
// 桌面端需要它做两件事：在用户的编辑器里打开文件、在系统浏览器里打开链接。
// 两者都必须是**系统级**的：不要自己内嵌一个编辑器，也不要内嵌一个浏览器
// ——用户机器上已经装好了他习惯的那一个，且那一个知道他的配置。
package shellopen

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// ErrNotFound 表示目标路径不存在。调用方应把它与"打开失败"区分开：
// 前者是用户看错了路径，后者才可能是环境问题。
var ErrNotFound = errors.New("路径不存在")

// OpenInEditor 用用户配置的编辑器打开文件。
//
// Args:
//
//	path: 要打开的文件或目录（绝对路径）
//
// Returns:
//
//	路径不存在返回 ErrNotFound；没有可用编辑器或系统调用失败时返回错误。
//
// 编辑器优先级：`$VISUAL` > `$EDITOR` > 平台默认关联程序。
// 前两个是 POSIX 约定，用户在终端里设置了就说明他期望 GUI 也用同一个；
// 只看平台关联会在装了多个编辑器时打开错的那个。
//
// 不会等待编辑器退出：编辑器是长期运行的进程，等待会把调用方挂死。
func OpenInEditor(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("解析路径失败: %w", err)
	}
	if _, statErr := os.Stat(abs); statErr != nil {
		return ErrNotFound
	}

	if cmdline := os.Getenv("VISUAL"); cmdline != "" {
		if startEditor(cmdline, abs) == nil {
			return nil
		}
	}
	if cmdline := os.Getenv("EDITOR"); cmdline != "" {
		if startEditor(cmdline, abs) == nil {
			return nil
		}
	}
	return openWithDefaultApp(abs)
}

// startEditor 用一条命令行模板启动编辑器。
//
// `$VISUAL` / `$EDITOR` 可能是 `code -w` 这样的带参数形式，
// 因此按空格切分而不是整串当命令名。
func startEditor(cmdline, path string) error {
	fields := strings.Fields(cmdline)
	if len(fields) == 0 {
		return errors.New("编辑器命令为空")
	}
	args := append(fields[1:], path)
	cmd := exec.Command(fields[0], args...)
	// 断开与父进程的 stdio：终端编辑器（vim/nano）在 GUI 进程里
	// 拿不到 TTY 会立即退出或行为异常。
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return err
	}
	// 不 Wait：编辑器是长期进程。但需要回收，否则会留僵尸进程。
	go func() { _ = cmd.Wait() }()
	return nil
}

// openWithDefaultApp 用平台默认关联程序打开路径。
func openWithDefaultApp(path string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// rundll32 比 `cmd /c start` 更安全：后者会把路径里的 & 之类
		// 当成命令分隔符，含空格或特殊字符的路径会执行出意外的东西。
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("打开失败: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// ErrUnsafeURL 表示链接的协议不在允许范围内。
var ErrUnsafeURL = errors.New("只允许打开 http/https 链接")

// ValidateExternalURL 校验外部链接是否可安全打开。
//
// 只接受 http/https：其它协议（`file:`、`javascript:`、自定义 scheme）
// 会变成任意代码执行或本地文件读取的入口，而调用方通常是服务端返回的
// 链接，属于不可信输入。
//
// 这个函数**不启动任何进程**，因此可以在测试里直接调用。
// 校验与执行分开是刻意的：把两者塞进一个函数，测试就必然带副作用——
// 曾经就是这样，跑一次单测会真的弹出用户的浏览器。
//
// Args:
//
//	rawURL: 待校验的链接
//
// Returns:
//
//	规范化后的链接；协议不允许或为空时返回 ErrUnsafeURL。
func ValidateExternalURL(rawURL string) (string, error) {
	trimmed := strings.TrimSpace(rawURL)
	lower := strings.ToLower(trimmed)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return "", fmt.Errorf("%w，实际 %q", ErrUnsafeURL, rawURL)
	}
	return trimmed, nil
}

// OpenExternal 用系统浏览器打开 URL。
//
// Args:
//
//	rawURL: 要打开的链接
//
// Returns:
//
//	协议不允许时返回包裹 ErrUnsafeURL 的错误，且**不会启动任何进程**。
func OpenExternal(rawURL string) error {
	url, err := ValidateExternalURL(rawURL)
	if err != nil {
		return err
	}
	return openWithDefaultApp(url)
}

// Reveal 在系统文件管理器里定位文件。
func Reveal(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("解析路径失败: %w", err)
	}
	if _, statErr := os.Stat(abs); statErr != nil {
		return ErrNotFound
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", "/select,", abs)
	case "darwin":
		cmd = exec.Command("open", "-R", abs)
	default:
		// 多数 Linux 文件管理器支持 --select；不支持时退回打开父目录。
		cmd = exec.Command("xdg-open", filepath.Dir(abs))
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("定位文件失败: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
