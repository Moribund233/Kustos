package shellopen

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 这里只测**判定逻辑**（协议白名单、路径校验）。
//
// 关键约束：**测试绝不能启动任何外部进程**。曾经这里直接调 OpenExternal
// 做"正向断言"，结果每次跑单测都会在开发者的机器上弹出浏览器——测试应当
// 零副作用。协议校验因此被抽成独立的纯函数，正向用例只调它。

func TestValidateExternalURLRejectsNonHTTPSchemes(t *testing.T) {
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
		_, err := ValidateExternalURL(raw)
		if err == nil {
			t.Errorf("%q 应被拒绝", raw)
			continue
		}
		// 用 errors.Is 而不是字符串匹配：错误文本会变，语义标识不会。
		if !errors.Is(err, ErrUnsafeURL) {
			t.Errorf("%q 应返回 ErrUnsafeURL，实际 %v", raw, err)
		}
	}
}

func TestValidateExternalURLAcceptsHTTPAndHTTPS(t *testing.T) {
	// 正向用例只跑校验函数，**不启动浏览器**。
	cases := []string{
		"https://example.com",
		"http://127.0.0.1:8000/x",
		"  https://kustos.example.com/path?q=1  ",
	}

	for _, raw := range cases {
		got, err := ValidateExternalURL(raw)
		if err != nil {
			t.Errorf("%q 应通过校验，实际 %v", raw, err)
			continue
		}
		if got != strings.TrimSpace(raw) {
			t.Errorf("应返回去掉首尾空白的链接，实际 %q", got)
		}
	}
}

// OpenExternal 对非法协议必须**在启动进程之前**就失败。
//
// 这条断言的是副作用边界：调用它不会拉起浏览器，因为校验先于执行。
func TestOpenExternalRejectsBeforeLaunching(t *testing.T) {
	for _, raw := range []string{"file:///etc/passwd", "javascript:alert(1)", ""} {
		if err := OpenExternal(raw); !errors.Is(err, ErrUnsafeURL) {
			t.Errorf("%q 应在启动进程前被拒绝，实际 %v", raw, err)
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
