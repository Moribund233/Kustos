package git

import (
	"strings"
	"testing"
)

// HeadDiff 的基准是 HEAD：编辑器行标要回答"相对上次提交改了什么"，
// 因此已暂存与未暂存的改动都必须出现在同一个结果里。

func TestHeadDiffIncludesUnstagedChange(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "line1\nline2\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "a.txt", "line1\nchanged\n")

	d, err := HeadDiff(dir, "a.txt")
	if err != nil {
		t.Fatalf("读 diff 失败: %v", err)
	}
	if !strings.Contains(d, "-line2") || !strings.Contains(d, "+changed") {
		t.Fatalf("工作树的改动应出现在相对 HEAD 的 diff 里:\n%s", d)
	}
}

// 这条是 HeadDiff 与 FileDiff(staged=false) 的关键区别：进过暂存区的改动
// 在 index↔工作树里是"没有差异"，但对 HEAD 仍然是新增。
func TestHeadDiffIncludesStagedChange(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "line1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "a.txt", "line1\nstaged\n")
	gitRun(t, dir, "add", "a.txt")

	d, err := HeadDiff(dir, "a.txt")
	if err != nil {
		t.Fatalf("读 diff 失败: %v", err)
	}
	if !strings.Contains(d, "+staged") {
		t.Fatalf("已暂存的改动也应出现在相对 HEAD 的 diff 里:\n%s", d)
	}

	// 同一时刻 FileDiff(staged=false) 是空的，正是它不能当行标基准的原因。
	unstaged, err := FileDiff(dir, "a.txt", false)
	if err != nil {
		t.Fatalf("读 diff 失败: %v", err)
	}
	if strings.TrimSpace(unstaged) != "" {
		t.Fatalf("暂存后的工作树相对索引应为空，实际:\n%s", unstaged)
	}
}

// 新文件在 HEAD 里没有版本，行标应该全是新增。
func TestHeadDiffUntrackedFileShowsAllAdded(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")
	write(t, dir, "new.txt", "brand new\nsecond\n")

	d, err := HeadDiff(dir, "new.txt")
	if err != nil {
		t.Fatalf("未跟踪文件不应报错: %v", err)
	}
	if !strings.Contains(d, "+brand new") || !strings.Contains(d, "+second") {
		t.Fatalf("未跟踪文件应给出整份新增:\n%s", d)
	}
}

func TestHeadDiffCleanFileIsEmpty(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "line1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	d, err := HeadDiff(dir, "a.txt")
	if err != nil {
		t.Fatalf("干净文件不应报错: %v", err)
	}
	if strings.TrimSpace(d) != "" {
		t.Fatalf("提交后相对 HEAD 应无差异，实际:\n%s", d)
	}
}

func TestHeadDiffRejectsEmptyPath(t *testing.T) {
	dir := newRepo(t)
	if _, err := HeadDiff(dir, ""); err == nil {
		t.Fatal("空路径应报错")
	}
}
