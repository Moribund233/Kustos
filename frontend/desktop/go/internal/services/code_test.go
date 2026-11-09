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
/* 变更列表（左栏 Changes 分段）                                        */
/* ------------------------------------------------------------------ */

// ListChanges 返回仓库内所有变更文件，供左栏"变更"分段直接展示。
//
// 树形浏览适合"我要找某个文件"，但改代码时用户想的是"我改了哪些文件"，
// 那是另一个入口，不该让他在树里逐层找。
func TestListChangesReturnsChangedFiles(t *testing.T) {
	svc, id, dir := newCodeFixture(t)

	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "new.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	changes, err := svc.ListChanges(id)
	if err != nil {
		t.Fatalf("列举变更失败: %v", err)
	}
	if len(changes) != 2 {
		t.Fatalf("应有 2 个变更，实际 %d: %+v", len(changes), changes)
	}

	byPath := map[string]TreeNode{}
	for _, c := range changes {
		byPath[c.Path] = c
	}
	if byPath["README.md"].Status != "M" {
		t.Errorf("README.md 应为 M，实际 %q", byPath["README.md"].Status)
	}
	if byPath["new.txt"].Status != "U" {
		t.Errorf("new.txt 应为 U，实际 %q", byPath["new.txt"].Status)
	}
}

func TestListChangesEmptyWhenClean(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	changes, err := svc.ListChanges(id)
	if err != nil {
		t.Fatalf("列举变更失败: %v", err)
	}
	if len(changes) != 0 {
		t.Fatalf("干净工作树不应有变更，实际 %+v", changes)
	}
}

/* ------------------------------------------------------------------ */
/* 文件搜索（左栏过滤框）                                              */
/* ------------------------------------------------------------------ */

// SearchFiles 按文件名子串搜索整个工作树。
//
// 用户在树里逐层展开找文件很慢，尤其是不记得放在哪个目录时。
// 这个接口返回相对仓库根的完整路径，前端点击即可打开。
func TestSearchFilesMatchesByName(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	results, err := svc.SearchFiles(id, "caret", 50)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("应命中 1 个文件，实际 %d: %+v", len(results), results)
	}
	if results[0].Path != "src/lib/caret.ts" {
		t.Errorf("路径应为 src/lib/caret.ts，实际 %q", results[0].Path)
	}
}

func TestSearchFilesIsCaseInsensitive(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	for _, q := range []string{"CARET", "Caret", "caret"} {
		results, err := svc.SearchFiles(id, q, 50)
		if err != nil {
			t.Fatalf("搜索 %q 失败: %v", q, err)
		}
		if len(results) != 1 {
			t.Errorf("%q 应命中 1 个文件，实际 %d", q, len(results))
		}
	}
}

// 搜索要容忍路径片段，不只是文件名。
func TestSearchFilesMatchesPathSegment(t *testing.T) {
	svc, id, _ := codeRepoWithNested(t)

	results, err := svc.SearchFiles(id, "lib/", 50)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("按路径片段应命中文件")
	}
	for _, r := range results {
		if !strings.Contains(r.Path, "lib/") {
			t.Errorf("结果 %q 不包含 lib/", r.Path)
		}
	}
}

func TestSearchFilesRespectsLimit(t *testing.T) {
	svc, id, dir := newCodeFixture(t)

	for i := 0; i < 20; i++ {
		writeFile(t, dir, "many/file"+string(rune('a'+i))+".txt", "x\n")
	}

	results, err := svc.SearchFiles(id, "file", 5)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(results) > 5 {
		t.Fatalf("应遵守上限 5，实际 %d", len(results))
	}
}

// 空查询返回空结果而不是整棵树：那会让界面在用户还没输入时先卡一次。
func TestSearchFilesEmptyQueryReturnsNothing(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	results, err := svc.SearchFiles(id, "  ", 50)
	if err != nil {
		t.Fatalf("空查询不应报错: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("空查询应返回空结果，实际 %d", len(results))
	}
}

func TestSearchFilesSkipsIgnoredDirs(t *testing.T) {
	svc, id, dir := newCodeFixture(t)

	// node_modules 里塞一个同名文件：搜索不应把它翻出来。
	writeFile(t, dir, "node_modules/pkg/caret.ts", "x\n")

	results, err := svc.SearchFiles(id, "caret", 50)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	for _, r := range results {
		if strings.Contains(r.Path, "node_modules") {
			t.Errorf("不应搜索 node_modules，实际 %q", r.Path)
		}
	}
}

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

// codeRepoWithNested 建一个更深一层的结构，用于路径片段搜索。
func codeRepoWithNested(t *testing.T) (*WorkingCopyService, string, string) {
	t.Helper()
	needGit(t)

	dir := initRepo(t)
	writeFile(t, dir, "src/lib/a.ts", "1\n")
	writeFile(t, dir, "src/lib/b.ts", "2\n")
	writeFile(t, dir, "src/app/c.ts", "3\n")
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "-m", "init")

	svc := newTestWorkingCopyService(t)
	wc, err := svc.Add(dir)
	if err != nil {
		t.Fatalf("添加工作副本失败: %v", err)
	}
	return svc, wc.ID, dir
}

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
