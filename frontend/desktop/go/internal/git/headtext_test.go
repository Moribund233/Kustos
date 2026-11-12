package git

import (
	"strings"
	"testing"
)

// HeadText 给的是 HEAD 原文而不是 diff：编辑器要拿它和当前缓冲区逐行比对，
// 缓冲区脏了行标也不能错位。

func TestHeadTextReturnsCommittedContent(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "line1\nline2\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	f, err := HeadText(dir, "a.txt")
	if err != nil {
		t.Fatalf("读 HEAD 版本失败: %v", err)
	}
	if !f.Exists {
		t.Fatal("已提交的文件应在 HEAD 里")
	}
	if f.Text != "line1\nline2\n" {
		t.Fatalf("内容 = %q", f.Text)
	}
	if f.Binary {
		t.Error("纯文本不应标记为二进制")
	}
}

// 提交后又改、还没提交：HEAD 版本必须仍是提交时那一份，
// 否则行标会拿"用户刚敲的字"和自己比，永远没有增删。
func TestHeadTextIgnoresDirtyWorktree(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "committed\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "a.txt", "edited in worktree\n")

	f, err := HeadText(dir, "a.txt")
	if err != nil {
		t.Fatalf("读 HEAD 版本失败: %v", err)
	}
	if f.Text != "committed\n" {
		t.Fatalf("应返回 HEAD 版本而非工作树内容，实际 %q", f.Text)
	}

	// 暂存但未提交也是同样的口径。
	gitRun(t, dir, "add", "a.txt")
	f, err = HeadText(dir, "a.txt")
	if err != nil {
		t.Fatalf("读 HEAD 版本失败: %v", err)
	}
	if f.Text != "committed\n" {
		t.Fatalf("已暂存的改动也不应算进 HEAD 版本，实际 %q", f.Text)
	}
}

// 未跟踪文件在 HEAD 里不存在：前端据此把整份内容都当成新增。
func TestHeadTextUntrackedFileDoesNotExist(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")
	write(t, dir, "new.txt", "brand new\n")

	f, err := HeadText(dir, "new.txt")
	if err != nil {
		t.Fatalf("未跟踪文件不应报错: %v", err)
	}
	if f.Exists {
		t.Fatal("未跟踪文件不应存在于 HEAD")
	}
	if f.Text != "" {
		t.Fatalf("不存在时内容应为空，实际 %q", f.Text)
	}
}

// 刚 add 还没提交的文件同样不在 HEAD 里，不该报错。
func TestHeadTextStagedOnlyFileDoesNotExist(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")
	write(t, dir, "new.txt", "brand new\n")
	gitRun(t, dir, "add", "new.txt")

	f, err := HeadText(dir, "new.txt")
	if err != nil {
		t.Fatalf("只暂存未提交不应报错: %v", err)
	}
	if f.Exists {
		t.Fatal("只进暂存区的文件不在 HEAD 里")
	}
}

// 二进制内容要能被识别出来，前端才不会把它塞进逐行对比。
func TestHeadTextMarksBinary(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "blob.bin", "\x00\x01\x02")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	f, err := HeadText(dir, "blob.bin")
	if err != nil {
		t.Fatalf("读 HEAD 版本失败: %v", err)
	}
	if !f.Binary {
		t.Fatal("含 NUL 的内容应标记为二进制")
	}
}

// 子目录里的文件也要能读到：路径是相对仓库根的。
func TestHeadTextInSubdirectory(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "目录/文件 名.txt", "原内容\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	f, err := HeadText(dir, "目录/文件 名.txt")
	if err != nil {
		t.Fatalf("读 HEAD 版本失败: %v", err)
	}
	if !f.Exists || !strings.Contains(f.Text, "原内容") {
		t.Fatalf("应读到中文路径的文件，实际 %+v", f)
	}
}

func TestHeadTextRejectsEmptyPath(t *testing.T) {
	dir := newRepo(t)
	if _, err := HeadText(dir, ""); err == nil {
		t.Fatal("空路径应报错")
	}
}
