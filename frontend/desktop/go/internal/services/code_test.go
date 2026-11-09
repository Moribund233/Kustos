package services

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Code 面的本地能力：列举工作树、读文件内容。
//
// 边界与工作副本一致——只回答"本机文件是什么"，不做权限判断。
// 但这里多一条硬约束：**所有路径必须收敛在仓库根之内**。
// 前端传来的是字符串，直接拼进 Join 会让 `../../etc/passwd` 读到仓库外。

/* ------------------------------------------------------------------ */
/* 文件树                                                              */
/* ------------------------------------------------------------------ */

func TestListTreeReturnsRootEntries(t *testing.T) {
	svc, id, dir := newCodeFixture(t)

	nodes, err := svc.ListTree(id, "")
	if err != nil {
		t.Fatalf("列举失败: %v", err)
	}
	names := nodeNames(nodes)

	if !contains(names, "src") {
		t.Errorf("应包含 src 目录，实际 %v", names)
	}
	if !contains(names, "README.md") {
		t.Errorf("应包含 README.md，实际 %v", names)
	}
	// 目录排在文件前面：与所有主流的文件树一致。
	if len(nodes) >= 2 && nodes[0].IsDir == false && nodes[1].IsDir == true {
		t.Errorf("目录应排在文件之前，实际 %+v", names)
	}
	_ = dir
}

// 隐藏文件默认不列：`.git` 里有上万个小文件，展开会把树刷爆。
func TestListTreeSkipsDotGit(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	nodes, err := svc.ListTree(id, "")
	if err != nil {
		t.Fatalf("列举失败: %v", err)
	}
	if contains(nodeNames(nodes), ".git") {
		t.Error("不应列出 .git")
	}
}

// 子目录要能列举，且路径相对仓库根。
func TestListTreeInSubdirectory(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	nodes, err := svc.ListTree(id, "src")
	if err != nil {
		t.Fatalf("列举失败: %v", err)
	}
	names := nodeNames(nodes)
	if !contains(names, "lib") {
		t.Errorf("src 下应包含 lib，实际 %v", names)
	}

	// 路径必须是相对仓库根的完整路径，前端据此拼接下一层。
	var lib *TreeNode
	for i := range nodes {
		if nodes[i].Name == "lib" {
			lib = &nodes[i]
		}
	}
	if lib == nil {
		t.Fatal("应找到 lib")
	}
	if lib.Path != "src/lib" {
		t.Errorf("路径应为 src/lib，实际 %q", lib.Path)
	}
}

// 文件树要带变更状态标记（原型里每行尾部的 M / A 之类）。
func TestListTreeMarksChangedFiles(t *testing.T) {
	svc, id, dir := newCodeFixture(t)

	// README.md 已在初始提交里；改一下它。
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	nodes, err := svc.ListTree(id, "")
	if err != nil {
		t.Fatalf("列举失败: %v", err)
	}
	for _, n := range nodes {
		if n.Path == "README.md" {
			if n.Status == "" {
				t.Error("被修改的文件应带状态标记")
			}
			return
		}
	}
	t.Fatal("应找到 README.md")
}

// 越界路径必须被拒绝。
func TestListTreeRejectsEscapingPaths(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	for _, bad := range []string{"../", "../../etc", "/etc", "..\\.."} {
		if _, err := svc.ListTree(id, bad); err == nil {
			t.Errorf("越界路径 %q 应被拒绝", bad)
		}
	}
}

func TestListTreeUnknownIDFails(t *testing.T) {
	svc, _, _ := newCodeFixture(t)
	if _, err := svc.ListTree("nope", ""); err == nil {
		t.Fatal("未知 ID 应报错")
	}
}

/* ------------------------------------------------------------------ */
/* 读文件                                                              */
/* ------------------------------------------------------------------ */

func TestReadFileReturnsContent(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	content, err := svc.ReadFile(id, "README.md")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if !strings.Contains(content, "seed") {
		t.Fatalf("内容不对: %q", content)
	}
}

func TestReadFileRejectsTraversal(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	for _, bad := range []string{"../../../etc/passwd", "/etc/passwd", "..\\..\\windows"} {
		if _, err := svc.ReadFile(id, bad); err == nil {
			t.Errorf("越界路径 %q 应被拒绝", bad)
		}
	}
}

func TestReadFileMissingFails(t *testing.T) {
	svc, id, _ := newCodeFixture(t)
	if _, err := svc.ReadFile(id, "nope.txt"); err == nil {
		t.Fatal("不存在的文件应报错")
	}
}

// 二进制文件不当作文本返回：那会在界面上渲染成乱码。
func TestReadFileRejectsBinary(t *testing.T) {
	svc, id, dir := newCodeFixture(t)

	if err := os.WriteFile(filepath.Join(dir, "blob.bin"), []byte{0x00, 0x01, 0x02}, 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	_, err := svc.ReadFile(id, "blob.bin")
	if err == nil {
		t.Fatal("二进制文件应被拒绝")
	}
	if !strings.Contains(err.Error(), "二进制") {
		t.Errorf("错误信息应说明是二进制文件，实际 %v", err)
	}
}

// 超大文件拒绝读取：把 500MB 的日志读进 WebView 会直接卡死。
func TestReadFileRejectsOversized(t *testing.T) {
	svc, id, dir := newCodeFixture(t)

	big := make([]byte, maxReadableBytes+1024)
	for i := range big {
		big[i] = 'a'
	}
	if err := os.WriteFile(filepath.Join(dir, "big.txt"), big, 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	_, err := svc.ReadFile(id, "big.txt")
	if err == nil {
		t.Fatal("超大文件应被拒绝")
	}
	if !strings.Contains(err.Error(), "过大") {
		t.Errorf("错误信息应说明文件过大，实际 %v", err)
	}
}

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

// newCodeFixture 建一个带 src/lib 结构的真实仓库。
func newCodeFixture(t *testing.T) (*WorkingCopyService, string, string) {
	t.Helper()
	needGit(t)

	dir := initRepo(t)
	writeFile(t, dir, "README.md", "seed\n")
	writeFile(t, dir, "src/lib/caret.ts", "export const x = 1;\n")
	writeFile(t, dir, "src/lib/client.ts", "export const y = 2;\n")
	writeFile(t, dir, "package.json", "{}\n")
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "-m", "init")

	svc := newTestWorkingCopyService(t)
	wc, err := svc.Add(dir)
	if err != nil {
		t.Fatalf("添加工作副本失败: %v", err)
	}
	return svc, wc.ID, dir
}

func nodeNames(nodes []TreeNode) []string {
	out := make([]string, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, n.Name)
	}
	sort.Strings(out)
	return out
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
