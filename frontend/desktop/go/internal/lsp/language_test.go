package lsp

import (
	"os"
	"path/filepath"
	"testing"
)

// 探测的失败模式是"判错语言"，而不是报错：判错时进程照样起得来，只是拿不到
// 类型信息，用户会以为是"LSP 不支持这个项目"。所以这组用例重点盯优先级与
// marker 的边界。

func TestDetectTypescriptFromPackageJSON(t *testing.T) {
	dir := t.TempDir()
	writeMarker(t, dir, "package.json")

	lang, ok := Detect(dir)
	if !ok {
		t.Fatal("package.json 应判定为 TypeScript")
	}
	if lang.ID != "typescript" {
		t.Errorf("语言 ID 应为 typescript，实际 %s", lang.ID)
	}
}

func TestDetectGoFromGoMod(t *testing.T) {
	dir := t.TempDir()
	writeMarker(t, dir, "go.mod")

	lang, ok := Detect(dir)
	if !ok {
		t.Fatal("go.mod 应判定为 Go")
	}
	if lang.ID != "go" {
		t.Errorf("语言 ID 应为 go，实际 %s", lang.ID)
	}
}

func TestDetectEmptyDirFindsNothing(t *testing.T) {
	if _, ok := Detect(t.TempDir()); ok {
		t.Error("空目录不应判定出语言")
	}
}

func TestDetectPrefersFirstMatchingLanguage(t *testing.T) {
	// 同时有 package.json 与 go.mod 的混合仓库（前端 + 后端）交给优先级决定：
	// 顺序被改掉时这里会红，而不是等到用户抱怨"Go 项目没有补全"。
	dir := t.TempDir()
	writeMarker(t, dir, "package.json")
	writeMarker(t, dir, "go.mod")

	lang, ok := Detect(dir)
	if !ok {
		t.Fatal("应判定出语言")
	}
	if lang.ID != Languages[0].ID {
		t.Errorf("应按探测表顺序取第一个，实际 %s", lang.ID)
	}
}

func TestDetectIgnoresMarkersInSubdirectories(t *testing.T) {
	// 只有下层目录里才有 marker（典型是 monorepo 的子包、或误留的 node_modules）
	// 时不判定：工作区根的语言决定整个会话，递归探测等于让一个依赖目录
	// 把整个仓库判成 TypeScript。
	dir := t.TempDir()
	sub := filepath.Join(dir, "nested")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	writeMarker(t, sub, "package.json")

	if _, ok := Detect(dir); ok {
		t.Error("子目录里的 marker 不应参与判定")
	}
}

func TestLookupKnownAndUnknown(t *testing.T) {
	lang, ok := Lookup("go")
	if !ok || lang.Server != "gopls" {
		t.Errorf("go 应映射到 gopls，实际 ok=%v server=%q", ok, lang.Server)
	}
	if _, ok := Lookup("brainfuck"); ok {
		t.Error("未知语言 ID 应返回 false")
	}
}

func TestEveryLanguageHasInstallHint(t *testing.T) {
	// 缺安装命令等于"探测到了但装不上时无话可说"，用户只会看到编辑器没有补全。
	for _, lang := range Languages {
		if lang.InstallHint == "" {
			t.Errorf("语言 %s 缺少安装提示", lang.ID)
		}
		if lang.Server == "" || len(lang.Markers) == 0 {
			t.Errorf("语言 %s 缺少服务器名或 marker", lang.ID)
		}
	}
}

func TestResolveMissingServerReturnsFalse(t *testing.T) {
	lang := Language{ID: "nope", Server: "kustos-nonexistent-server-for-test"}
	if _, ok := lang.Resolve(); ok {
		t.Error("不存在的服务器应返回 false")
	}
}

func TestArgsForStdioServers(t *testing.T) {
	python, _ := Lookup("python")
	if got := python.Args(); len(got) != 1 || got[0] != "--stdio" {
		t.Errorf("pyright 需要显式 --stdio，实际 %v", got)
	}
	goLang, _ := Lookup("go")
	if got := goLang.Args(); len(got) != 0 {
		t.Errorf("gopls 默认走 stdio，不需要额外参数，实际 %v", got)
	}
}

// writeMarker 在 dir 下写一个空的 marker 文件。
func writeMarker(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("{}"), 0o644); err != nil {
		t.Fatalf("写 marker %s 失败: %v", name, err)
	}
}
