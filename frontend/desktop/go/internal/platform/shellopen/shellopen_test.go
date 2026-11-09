package shellopen

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 这里能测的主要是**判定逻辑**（协议白名单、路径校验），
// 真正的进程启动在 CI 上不可控，也不该在测试里弹窗口。

func TestOpenExternalRejectsNonHTTPSchemes(t *testing.T) {
	// 这些是真实的攻击面：服务端返回的链接、用户粘贴的内容都可能带这些前缀。
	cases := []string{
		"file:///etc/passwd",
		"javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"vbscript:msgbox",
		"chrome://settings",
		"ms-settings:privacy",
		"  javascript:alert(1)",
		"JAVASCRIPT:alert(1)",
		"",
	}

	for _, raw := range cases {
		err := OpenExternal(raw)
		if err == nil {
			t.Errorf("%q 应被拒绝", raw)
			continue
		}
		if !strings.Contains(err.Error(), "http") {
			t.Errorf("%q 的错误信息应说明只允许 http/https，实际 %v", raw, err)
		}
	}
}

func TestOpenExternalAcceptsHTTPAndHTTPS(t *testing.T) {
	// 这两种应当通过校验。实际启动浏览器在测试环境里不可控，
	// 因此只断言"没有被协议校验拦下"。
	for _, raw := range []string{"https://example.com", "http://127.0.0.1:8000/x"} {
		err := OpenExternal(raw)
		if err != nil && strings.Contains(err.Error(), "只允许") {
			t.Errorf("%q 不应被协议校验拒绝，实际 %v", raw, err)
		}
	}
}

func TestOpenInEditorMissingPath(t *testing.T) {
	err := OpenInEditor(filepath.Join(t.TempDir(), "nope.txt"))
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的路径应返回 ErrNotFound，实际 %v", err)
	}
}

func TestRevealMissingPath(t *testing.T) {
	err := Reveal(filepath.Join(t.TempDir(), "nope.txt"))
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的路径应返回 ErrNotFound，实际 %v", err)
	}
}

// $VISUAL / $EDITOR 里的命令可能带参数（如 `code -w`）。
// 解析失败时应当退回平台默认程序，而不是直接报错让用户无法打开文件。
func TestOpenInEditorToleratesBrokenEditorEnv(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	// 指向一个不存在的可执行文件：应当退回默认程序，而不是返回错误
	// （在无桌面环境里默认程序也可能失败，因此这里只要求"不 panic"）。
	t.Setenv("VISUAL", "definitely-not-a-real-editor-xyz")
	t.Setenv("EDITOR", "")

	_ = OpenInEditor(file)

	// 命令行为空串时不应崩。
	t.Setenv("VISUAL", "   ")
	_ = OpenInEditor(file)
}
