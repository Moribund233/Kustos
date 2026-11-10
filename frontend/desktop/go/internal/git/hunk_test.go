package git

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// hunk 级暂存的测试全部基于真实仓库：这条路径上真正危险的是
// "生成的 patch 与 index 里的内容对不上"，mock 掉 git 只会测到自己的想象。

// hunkHeaderRe 抓统一 diff 的 hunk 头。
// 界面传回的 header 是原文（可能带函数名后缀），校验只比对前缀的区间部分。
var hunkHeaderRe = regexp.MustCompile(`^@@ -\d+(,\d+)? \+\d+(,\d+)? @@`)

// twoHunkFile 生成一个改动分处两个 hunk 的文件内容：
// 两处改动相隔足够多的未改动行，git 才会把它们切成两个 hunk（默认 3 行上下文）。
func twoHunkFile(markerA, markerB string) string {
	var b strings.Builder
	for i := 1; i <= 24; i++ {
		line := fmt.Sprintf("L%02d\n", i)
		switch i {
		case 3:
			line = markerA + "\n"
		case 18:
			line = markerB + "\n"
		}
		b.WriteString(line)
	}
	return b.String()
}

// setupTwoHunks 建一个"两个 hunk 都未暂存"的仓库。
func setupTwoHunks(t *testing.T) (dir string) {
	t.Helper()
	dir = newRepo(t)
	write(t, dir, "code.txt", twoHunkFile("L03", "L18"))
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "code.txt", twoHunkFile("A-CHANGED", "B-CHANGED"))
	return dir
}

// diffHeaders 返回某侧 diff 的 hunk 头原文，按出现顺序。
func diffHeaders(t *testing.T, dir, path string, staged bool) []string {
	t.Helper()
	d, err := FileDiff(dir, path, staged)
	if err != nil {
		t.Fatalf("读 diff 失败: %v", err)
	}
	var out []string
	for _, line := range strings.Split(d, "\n") {
		if hunkHeaderRe.MatchString(line) {
			out = append(out, line)
		}
	}
	return out
}

/* ------------------------------------------------------------------ */
/* 逐 hunk 暂存                                                        */
/* ------------------------------------------------------------------ */

// 暂存单个 hunk 后，index 里只应有这一块，另一块仍留在未暂存侧。
func TestStageHunkOnlyTouchesTargetHunk(t *testing.T) {
	dir := setupTwoHunks(t)

	headers := diffHeaders(t, dir, "code.txt", false)
	if len(headers) != 2 {
		t.Fatalf("构造失败：应有 2 个 hunk，实际 %d:\n%s", len(headers), strings.Join(headers, "\n"))
	}

	if err := StageHunk(dir, "code.txt", headers[0]); err != nil {
		t.Fatalf("暂存第一个 hunk 失败: %v", err)
	}

	// 暂存区侧：只含第一块。
	staged, err := FileDiff(dir, "code.txt", true)
	if err != nil {
		t.Fatalf("读暂存区 diff 失败: %v", err)
	}
	if !strings.Contains(staged, "+A-CHANGED") {
		t.Fatalf("暂存区应含目标 hunk 的改动:\n%s", staged)
	}
	if strings.Contains(staged, "B-CHANGED") {
		t.Fatalf("暂存区不应含另一个 hunk:\n%s", staged)
	}
	if hs := hunkCount(staged); hs != 1 {
		t.Fatalf("暂存区应只有 1 个 hunk，实际 %d:\n%s", hs, staged)
	}

	// 工作区侧：另一块还在。
	unstaged, err := FileDiff(dir, "code.txt", false)
	if err != nil {
		t.Fatalf("读工作区 diff 失败: %v", err)
	}
	if !strings.Contains(unstaged, "+B-CHANGED") {
		t.Fatalf("另一 hunk 应仍留在工作区:\n%s", unstaged)
	}
	if strings.Contains(unstaged, "A-CHANGED") {
		t.Fatalf("已暂存的改动不该再出现在未暂存侧:\n%s", unstaged)
	}

	// 磁盘内容不受影响：暂存不该动工作树。
	if got := readFile(t, dir, "code.txt"); !strings.Contains(got, "A-CHANGED") || !strings.Contains(got, "B-CHANGED") {
		t.Fatalf("工作树内容被改动了:\n%s", got)
	}
}

// 只暂存一个 hunk 后提交，提交里只有这一块，另一块继续留在工作区。
//
// 这是"部分暂存"存在的唯一理由：用户想分两次提交同一文件的改动。
func TestStageHunkThenCommitKeepsRestInWorktree(t *testing.T) {
	dir := setupTwoHunks(t)

	headers := diffHeaders(t, dir, "code.txt", false)
	if err := StageHunk(dir, "code.txt", headers[0]); err != nil {
		t.Fatalf("暂存失败: %v", err)
	}
	if err := Commit(dir, "只提交第一处改动", false); err != nil {
		t.Fatalf("提交失败: %v", err)
	}

	shown := gitRun(t, dir, "show", "--name-only", "--format=", "HEAD")
	if !strings.Contains(shown, "code.txt") {
		t.Fatalf("提交应包含 code.txt:\n%s", shown)
	}
	body := gitRun(t, dir, "show", "HEAD")
	if !strings.Contains(body, "+A-CHANGED") {
		t.Fatalf("提交内容应只含第一处改动:\n%s", body)
	}
	if strings.Contains(body, "+B-CHANGED") {
		t.Fatalf("提交不该含未暂存的那处改动:\n%s", body)
	}

	st, err := RepoStatus(dir)
	if err != nil {
		t.Fatalf("读状态失败: %v", err)
	}
	if !st.Dirty {
		t.Fatal("另一 hunk 还在工作区，提交后应仍为 dirty")
	}
	remaining := hunkCount(mustDiff(t, dir, "code.txt", false))
	if remaining != 1 {
		t.Fatalf("工作区应剩 1 个 hunk，实际 %d", remaining)
	}
}

// 连续暂存两个 hunk 后，暂存区应拿到整文件的改动。
//
// 第二块暂存时 index 已变，行号会漂移；这里验证重新读到的 diff
// 仍然能与界面传来的 header 对上。
func TestStageHunksAccumulateToWholeFile(t *testing.T) {
	dir := setupTwoHunks(t)

	headers := diffHeaders(t, dir, "code.txt", false)
	for i, h := range headers {
		if err := StageHunk(dir, "code.txt", h); err != nil {
			t.Fatalf("暂存第 %d 个 hunk 失败: %v", i+1, err)
		}
	}

	staged := mustDiff(t, dir, "code.txt", true)
	if !strings.Contains(staged, "+A-CHANGED") || !strings.Contains(staged, "+B-CHANGED") {
		t.Fatalf("两块都暂存后 index 应含全部改动:\n%s", staged)
	}
	if unstaged := mustDiff(t, dir, "code.txt", false); strings.TrimSpace(unstaged) != "" {
		t.Fatalf("都暂存后未暂存侧应为空:\n%s", unstaged)
	}

	st, _ := RepoStatus(dir)
	for _, c := range st.Changes {
		if c.Path == "code.txt" && c.HasUnstaged {
			t.Error("全部 hunk 已暂存，不该还标记有未暂存改动")
		}
	}
}

/* ------------------------------------------------------------------ */
/* 逐 hunk 取消暂存                                                    */
/* ------------------------------------------------------------------ */

// 从暂存区撤回单个 hunk：另一块必须留在 index，被撤回的那块回到未暂存侧。
func TestUnstageHunkReversesOnlyTarget(t *testing.T) {
	dir := setupTwoHunks(t)
	if err := Stage(dir, []string{"code.txt"}); err != nil {
		t.Fatalf("整文件暂存失败: %v", err)
	}

	headers := diffHeaders(t, dir, "code.txt", true)
	if len(headers) != 2 {
		t.Fatalf("构造失败：暂存区应有 2 个 hunk，实际 %d", len(headers))
	}

	if err := UnstageHunk(dir, "code.txt", headers[1]); err != nil {
		t.Fatalf("取消暂存第二个 hunk 失败: %v", err)
	}

	staged := mustDiff(t, dir, "code.txt", true)
	if strings.Contains(staged, "B-CHANGED") {
		t.Fatalf("第二个 hunk 应已从 index 撤回:\n%s", staged)
	}
	if !strings.Contains(staged, "+A-CHANGED") {
		t.Fatalf("第一个 hunk 应留在暂存区:\n%s", staged)
	}

	unstaged := mustDiff(t, dir, "code.txt", false)
	if !strings.Contains(unstaged, "+B-CHANGED") {
		t.Fatalf("撤回的改动应回到未暂存侧:\n%s", unstaged)
	}
	if strings.Contains(unstaged, "A-CHANGED") {
		t.Fatalf("仍在暂存区的改动不该出现在未暂存侧:\n%s", unstaged)
	}

	// 工作树内容始终不动。
	if got := readFile(t, dir, "code.txt"); !strings.Contains(got, "A-CHANGED") || !strings.Contains(got, "B-CHANGED") {
		t.Fatalf("取消暂存不该改工作树:\n%s", got)
	}
}

// 撤回不存在的 hunk 同样要失败，而不是把整文件从 index 里抹掉。
func TestUnstageHunkHeaderMismatchKeepsIndex(t *testing.T) {
	dir := setupTwoHunks(t)
	if err := Stage(dir, []string{"code.txt"}); err != nil {
		t.Fatalf("整文件暂存失败: %v", err)
	}

	before := mustDiff(t, dir, "code.txt", true)
	err := UnstageHunk(dir, "code.txt", "@@ -999,7 +999,9 @@")
	if err == nil {
		t.Fatal("header 失配时应报错")
	}
	after := mustDiff(t, dir, "code.txt", true)
	if before != after {
		t.Fatal("报错后 index 不该发生变化")
	}
}

/* ------------------------------------------------------------------ */
/* 陈旧性校验                                                          */
/* ------------------------------------------------------------------ */

// header 是界面的快照，Go 侧重新读到的 diff 里找不到它就必须报错。
//
// 绝不"就近猜一个 hunk"：猜错的后果是把用户没打算提交的改动写进 index，
// 而提交之后用户很难发现多进去的是什么。
func TestStageHunkRejectsStaleHeader(t *testing.T) {
	dir := setupTwoHunks(t)

	stale := "@@ -3,7 +3,7 @@"
	headers := diffHeaders(t, dir, "code.txt", false)
	if len(headers) > 0 && strings.HasPrefix(headers[0], stale) {
		t.Fatalf("构造失败：测试用的 header 恰好命中了真实 hunk: %q", headers[0])
	}

	err := StageHunk(dir, "code.txt", stale)
	if err == nil {
		t.Fatal("header 失配时应报错")
	}
	if staged := mustDiff(t, dir, "code.txt", true); strings.TrimSpace(staged) != "" {
		t.Fatalf("报错后不该往 index 写任何东西:\n%s", staged)
	}
}

// 文件内容在界面渲染之后被外部改动，行号会漂移：
// 旧 header 找不到，新 header 才对得上。
func TestStageHunkDetectsExternalEdit(t *testing.T) {
	dir := setupTwoHunks(t)

	headers := diffHeaders(t, dir, "code.txt", false)
	// 在第一个 hunk 之前插入若干行，使两个 hunk 的行号都发生变化。
	content := readFile(t, dir, "code.txt")
	write(t, dir, "code.txt", "padding\npadding\npadding\n"+content)

	if err := StageHunk(dir, "code.txt", headers[0]); err == nil {
		t.Fatal("行号漂移后旧 header 应被拒绝")
	}

	fresh := diffHeaders(t, dir, "code.txt", false)
	if len(fresh) != 2 {
		t.Fatalf("改动仍是两个 hunk，实际 %d", len(fresh))
	}
	if err := StageHunk(dir, "code.txt", fresh[0]); err != nil {
		t.Fatalf("用刷新后的 header 应能暂存: %v", err)
	}
}

// 没有任何改动的文件不该被暂存出空 patch。
func TestStageHunkOnCleanFileFails(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	if err := StageHunk(dir, "a.txt", "@@ -1,1 +1,1 @@"); err == nil {
		t.Fatal("无改动时按 hunk 暂存应报错")
	}
	if err := UnstageHunk(dir, "a.txt", "@@ -1,1 +1,1 @@"); err == nil {
		t.Fatal("暂存区无改动时按 hunk 取消暂存应报错")
	}
}

// header 为空是调用方的错误，要明确拒绝而不是当成"匹配第一个"。
func TestStageHunkRejectsEmptyHeader(t *testing.T) {
	dir := setupTwoHunks(t)
	if err := StageHunk(dir, "code.txt", "  "); err == nil {
		t.Fatal("空 header 应被拒绝")
	}
}

/* ------------------------------------------------------------------ */
/* 未跟踪文件                                                          */
/* ------------------------------------------------------------------ */

// 未跟踪文件还没有"暂存区相对版本"，hunk 级暂存对它没有意义。
// 错误信息要直接告诉用户改走整文件暂存，否则界面只会显示一句看不懂的话。
func TestStageHunkUntrackedFileGivesReadableError(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "brand-new.txt", "line one\nline two\nline three\n")

	err := StageHunk(dir, "brand-new.txt", "@@ -0,0 +1,3 @@")
	if err == nil {
		t.Fatal("未跟踪文件按 hunk 暂存应报错")
	}
	msg := err.Error()
	if !strings.Contains(msg, "未跟踪") || !strings.Contains(msg, "整文件") {
		t.Fatalf("错误信息应说明该走整文件暂存，实际 %q", msg)
	}

	// 取消暂存同样不适用。
	if err := UnstageHunk(dir, "brand-new.txt", "@@ -0,0 +1,3 @@"); err == nil {
		t.Fatal("未跟踪文件按 hunk 取消暂存应报错")
	}
}

/* ------------------------------------------------------------------ */
/* patch 拼装（纯函数）                                                */
/* ------------------------------------------------------------------ */

const sampleDiff = "diff --git a/code.txt b/code.txt\n" +
	"index 1111111..2222222 100644\n" +
	"--- a/code.txt\n" +
	"+++ b/code.txt\n" +
	"@@ -3,7 +3,7 @@\n" +
	" L02\n" +
	"-L03\n" +
	"+A-CHANGED\n" +
	" L04\n" +
	"@@ -18,7 +18,7 @@\n" +
	" L17\n" +
	"-L18\n" +
	"+B-CHANGED\n" +
	" L19\n"

// 拼出的最小 patch 必须是"文件头 + 单个 hunk"：
// 多带另一个 hunk 就会把用户没选的改动一起写进 index。
func TestExtractHunkPatchBuildsMinimalPatch(t *testing.T) {
	patch, err := extractHunkPatch(sampleDiff, "@@ -3,7 +3,7 @@")
	if err != nil {
		t.Fatalf("拼装失败: %v", err)
	}
	if !strings.HasPrefix(patch, "diff --git a/code.txt b/code.txt\n") {
		t.Fatalf("patch 应保留文件头:\n%s", patch)
	}
	if !strings.Contains(patch, "@@ -3,7 +3,7 @@") {
		t.Fatalf("patch 应含目标 hunk:\n%s", patch)
	}
	if strings.Contains(patch, "@@ -18,7") || strings.Contains(patch, "B-CHANGED") {
		t.Fatalf("patch 不该含另一个 hunk:\n%s", patch)
	}
	if !strings.HasSuffix(patch, "\n") {
		t.Fatalf("patch 应以换行结尾，否则 git apply 可能拒绝:\n%q", patch)
	}
}

// header 原文可能带函数名后缀（原型与解析器都保留整行），比对只取区间部分。
func TestExtractHunkPatchIgnoresFuncnameSuffix(t *testing.T) {
	withFunc := "diff --git a/f.py b/f.py\n" +
		"index 1111111..2222222 100644\n" +
		"--- a/f.py\n" +
		"+++ b/f.py\n" +
		"@@ -3,7 +3,7 @@ def step(self):\n" +
		" x\n"

	patch, err := extractHunkPatch(withFunc, "@@ -3,7 +3,7 @@")
	if err != nil {
		t.Fatalf("应能容忍函数名后缀: %v", err)
	}
	if !strings.Contains(patch, "@@ -3,7 +3,7 @@ def step") {
		t.Fatalf("hunk 头应原样保留:\n%s", patch)
	}
}

func TestExtractHunkPatchRejectsMissingHunk(t *testing.T) {
	if _, err := extractHunkPatch(sampleDiff, "@@ -42,7 +42,7 @@"); err == nil {
		t.Fatal("找不到目标 hunk 时应报错")
	}
	if _, err := extractHunkPatch("", "@@ -3,7 +3,7 @@"); err == nil {
		t.Fatal("空 diff 时应报错")
	}
}

// 二进制与无行号变更的 diff 不含 hunk，要给出可读错误而不是把空 patch 交给 git。
func TestExtractHunkPatchRejectsBinaryDiff(t *testing.T) {
	binary := "diff --git a/x.png b/x.png\nindex 1111111..2222222 100644\nBinary files a/x.png and b/x.png differ\n"
	if _, err := extractHunkPatch(binary, "@@ -1,1 +1,1 @@"); err == nil {
		t.Fatal("二进制 diff 应报错")
	}
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

func hunkCount(diff string) int {
	n := 0
	for _, line := range strings.Split(diff, "\n") {
		if hunkHeaderRe.MatchString(line) {
			n++
		}
	}
	return n
}

func mustDiff(t *testing.T, dir, path string, staged bool) string {
	t.Helper()
	d, err := FileDiff(dir, path, staged)
	if err != nil {
		t.Fatalf("读 diff 失败: %v", err)
	}
	return d
}

func readFile(t *testing.T, dir, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("读文件失败: %v", err)
	}
	return string(data)
}
