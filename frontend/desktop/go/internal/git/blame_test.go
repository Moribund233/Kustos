package git

import (
	"strings"
	"testing"
)

// blame 的断言全部基于真实 git 输出。这里刻意用两次不同作者、不同时间的
// 提交：blame 最容易错的地方就是"同一提交的多行共用一次头信息"和
// "时间单位换算"，单次提交的仓库测不出来。

// commitAs 用指定作者与时间提交，时间用 unix 秒表达。
//
// 走 `-c` 与 `--date=@<秒>` 而不是改环境变量：这套写法在任何平台行为一致，
// 也不依赖测试进程之外的配置。
func commitAs(t *testing.T, dir, name, email, when, message string, extra ...string) {
	t.Helper()
	args := []string{"-c", "user.name=" + name, "-c", "user.email=" + email, "commit", "--date=@" + when, "-m", message}
	gitRun(t, dir, append(args, extra...)...)
}

func TestBlameReportsCommitPerLine(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "one\ntwo\nthree\n")
	gitRun(t, dir, "add", ".")
	commitAs(t, dir, "Alice", "alice@example.invalid", "1577934245", "first commit")

	write(t, dir, "a.txt", "one\ntwo changed\nthree\n")
	gitRun(t, dir, "add", ".")
	commitAs(t, dir, "Bob", "bob@example.invalid", "1609470245", "second commit")

	first := strings.TrimSpace(gitRun(t, dir, "rev-parse", "HEAD^"))
	second := strings.TrimSpace(gitRun(t, dir, "rev-parse", "HEAD"))

	lines, err := Blame(dir, "a.txt")
	if err != nil {
		t.Fatalf("blame 失败: %v", err)
	}
	if len(lines) != 3 {
		t.Fatalf("应有 3 行，实际 %d: %+v", len(lines), lines)
	}

	want := []BlameLine{
		{Line: 1, Commit: first, Author: "Alice", Time: 1577934245 * 1000, Summary: "first commit"},
		{Line: 2, Commit: second, Author: "Bob", Time: 1609470245 * 1000, Summary: "second commit"},
		{Line: 3, Commit: first, Author: "Alice", Time: 1577934245 * 1000, Summary: "first commit"},
	}
	for i, w := range want {
		if lines[i] != w {
			t.Errorf("第 %d 行 = %+v，期望 %+v", i+1, lines[i], w)
		}
	}
}

// 工作树里改过但没提交的行没有归属提交，界面不该显示"上一版是谁写的"
// 来冒充这一行。
func TestBlameLeavesUncommittedLinesEmpty(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "one\ntwo\n")
	gitRun(t, dir, "add", ".")
	commitAs(t, dir, "Alice", "alice@example.invalid", "1577934245", "first commit")

	write(t, dir, "a.txt", "one\nedited but not committed\n")

	lines, err := Blame(dir, "a.txt")
	if err != nil {
		t.Fatalf("blame 失败: %v", err)
	}
	if len(lines) != 2 {
		t.Fatalf("应有 2 行，实际 %d: %+v", len(lines), lines)
	}
	if lines[0].Commit == "" || lines[0].Author != "Alice" {
		t.Errorf("未改动的行应保留归属，实际 %+v", lines[0])
	}
	got := lines[1]
	if got.Line != 2 {
		t.Errorf("行号 = %d，期望 2", got.Line)
	}
	if got.Commit != "" || got.Author != "" || got.Summary != "" || got.Time != 0 {
		t.Errorf("未提交的行应全部留空，实际 %+v", got)
	}
}

// 未跟踪文件没有 HEAD 版本：返回空结果而不是错误，让编辑器安静地不显示标记。
func TestBlameUntrackedFileIsEmpty(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitRun(t, dir, "add", ".")
	commitAs(t, dir, "Alice", "alice@example.invalid", "1577934245", "first commit")
	write(t, dir, "new.txt", "brand new\n")

	lines, err := Blame(dir, "new.txt")
	if err != nil {
		t.Fatalf("未跟踪文件不应报错: %v", err)
	}
	if len(lines) != 0 {
		t.Fatalf("未跟踪文件应返回空结果，实际 %+v", lines)
	}
}

// 空仓库（还没有任何提交）里 blame 必然失败，同样按"没有归属"处理。
func TestBlameWithoutHeadIsEmpty(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitRun(t, dir, "add", ".")

	lines, err := Blame(dir, "a.txt")
	if err != nil {
		t.Fatalf("没有提交时不应报错: %v", err)
	}
	if len(lines) != 0 {
		t.Fatalf("没有提交时应返回空结果，实际 %+v", lines)
	}
}

func TestBlameRejectsEmptyPath(t *testing.T) {
	dir := newRepo(t)
	if _, err := Blame(dir, ""); err == nil {
		t.Fatal("空路径应报错")
	}
}
