package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// 这些测试用真实的临时 git 仓库，不用 mock。
//
// 理由：这个包的全部价值就是"解析真实 git 的输出"。用 mock 把输出换成
// 自己想的格式，测的只是自己的想象；真实输出的边界情况（重命名、未跟踪目录、
// 中文路径、CRLF）恰恰是这类代码最容易翻车的地方。
//
// 没有 git 可执行文件时跳过而不是失败：桌面端要求用户机器上有 git，
// 但 CI 的纯 Go 环境未必有。

// needGit 在没有 git 可执行文件时跳过测试。
func needGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过真实仓库测试")
	}
}

// newRepo 建一个临时仓库并返回其路径。
func newRepo(t *testing.T) string {
	t.Helper()
	needGit(t)

	dir := t.TempDir()
	// 统一为 LF：Windows 上 core.autocrlf 默认为 true，会让 diff 里全是
	// 行尾差异，测试断言就变得与机器配置相关。
	for _, args := range [][]string{
		{"init", "-b", "main"},
		{"config", "user.email", "test@example.invalid"},
		{"config", "user.name", "Test"},
		{"config", "core.autocrlf", "false"},
	} {
		gitRun(t, dir, args...)
	}
	return dir
}

func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s 失败: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	full := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
}

/* ------------------------------------------------------------------ */
/* 仓库识别                                                            */
/* ------------------------------------------------------------------ */

func TestIsRepository(t *testing.T) {
	dir := newRepo(t)
	ok, err := IsRepository(dir)
	if err != nil {
		t.Fatalf("识别失败: %v", err)
	}
	if !ok {
		t.Fatal("刚初始化的目录应被识别为仓库")
	}

	plain := t.TempDir()
	ok, err = IsRepository(plain)
	if err != nil {
		t.Fatalf("识别普通目录不应报错: %v", err)
	}
	if ok {
		t.Fatal("普通目录不应被识别为仓库")
	}
}

// 子目录也属于仓库：用户可能选了仓库里的某个包目录。
func TestIsRepositoryInSubdirectory(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "pkg/file.txt", "x")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	ok, err := IsRepository(filepath.Join(dir, "pkg"))
	if err != nil {
		t.Fatalf("识别失败: %v", err)
	}
	if !ok {
		t.Fatal("仓库子目录也应被识别")
	}
}

func TestIsRepositoryRejectsMissingPath(t *testing.T) {
	if _, err := IsRepository(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("不存在的路径应报错，而不是静默当成非仓库")
	}
}

/* ------------------------------------------------------------------ */
/* 状态解析                                                            */
/* ------------------------------------------------------------------ */

func TestRepoStatusClean(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "hello\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	st, err := RepoStatus(dir)
	if err != nil {
		t.Fatalf("读状态失败: %v", err)
	}
	if st.Branch != "main" {
		t.Errorf("分支 = %q", st.Branch)
	}
	if st.Dirty {
		t.Error("刚提交完不应为 dirty")
	}
	if len(st.Changes) != 0 {
		t.Errorf("应有 0 个变更，实际 %d", len(st.Changes))
	}
}

// 未跟踪、修改、删除、重命名要分别归入正确状态，且重命名必须能读到原路径。
func TestRepoStatusReportsChangeKinds(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "keep.txt", "keep\n")
	write(t, dir, "modify.txt", "before\n")
	write(t, dir, "remove.txt", "gone\n")
	write(t, dir, "rename-me.txt", "same content that is long enough\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "modify.txt", "after\n")
	write(t, dir, "untracked.txt", "new\n")
	gitRun(t, dir, "rm", "--quiet", "remove.txt")
	gitRun(t, dir, "mv", "rename-me.txt", "renamed.txt")

	st, err := RepoStatus(dir)
	if err != nil {
		t.Fatalf("读状态失败: %v", err)
	}
	if !st.Dirty {
		t.Fatal("有未提交改动时应为 dirty")
	}

	byPath := map[string]Change{}
	for _, c := range st.Changes {
		byPath[c.Path] = c
	}

	if c, ok := byPath["modify.txt"]; !ok || c.Kind != KindModified {
		t.Errorf("modify.txt 归类错误: %+v", c)
	}
	if c, ok := byPath["untracked.txt"]; !ok || c.Kind != KindUntracked {
		t.Errorf("untracked.txt 归类错误: %+v", c)
	}
	if c, ok := byPath["remove.txt"]; !ok || c.Kind != KindDeleted {
		t.Errorf("remove.txt 归类错误: %+v", c)
	}
	if c, ok := byPath["renamed.txt"]; !ok {
		t.Errorf("重命名后应出现在新路径，实际 %v", keys(byPath))
	} else if c.Kind != KindRenamed {
		t.Errorf("renamed.txt 应为重命名，实际 %q", c.Kind)
	}
}

// 中文与空格路径必须原样保留：git 默认会给非 ASCII 路径加引号并转义成
// 八进制序列，不关掉 core.quotepath 就会读到乱码路径，后续 git 命令全部失败。
//
// 这条测试刻意走 FileDiff 而不是 RepoStatus：`-z` 本身就不转义路径，
// 拿 status 来验证 quotepath 会得到一个"永远通过"的假测试。
func TestNonASCIIPathsSurviveQuotepath(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "目录/文件 名.txt", "原内容\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "目录/文件 名.txt", "改过的内容\n")

	d, err := FileDiff(dir, "目录/文件 名.txt", false)
	if err != nil {
		t.Fatalf("读 diff 失败: %v", err)
	}
	if strings.Contains(d, `\346`) || strings.Contains(d, `\344`) {
		t.Fatalf("diff 里的路径被转义成八进制了，说明 core.quotepath 没关掉:\n%s", d)
	}
	if !strings.Contains(d, "+改过的内容") {
		t.Fatalf("diff 内容不对:\n%s", d)
	}
}

// Status 的路径也要原样（-z 本身不转义，这里防的是将来改用非 -z 解析）。
func TestRepoStatusHandlesNonASCIIPaths(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "目录/文件 名.txt", "内容\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "目录/新文件.txt", "x\n")

	st, err := RepoStatus(dir)
	if err != nil {
		t.Fatalf("读状态失败: %v", err)
	}
	var found bool
	for _, c := range st.Changes {
		if strings.Contains(c.Path, "新文件") {
			found = true
		}
		if strings.Contains(c.Path, `\`) {
			t.Errorf("路径不应包含转义: %q", c.Path)
		}
	}
	if !found {
		t.Fatalf("应读到中文路径，实际 %v", keys2(st.Changes))
	}
}

// 已暂存的改动要与未暂存的分开：界面要能分别展示两栏。
func TestRepoStatusSeparatesStagedAndUnstaged(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	write(t, dir, "b.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "a.txt", "2\n")
	gitRun(t, dir, "add", "a.txt")
	write(t, dir, "b.txt", "2\n")

	st, err := RepoStatus(dir)
	if err != nil {
		t.Fatalf("读状态失败: %v", err)
	}

	byPath := map[string]Change{}
	for _, c := range st.Changes {
		byPath[c.Path] = c
	}
	if !byPath["a.txt"].Staged {
		t.Error("a.txt 应标记为已暂存")
	}
	if byPath["b.txt"].Staged {
		t.Error("b.txt 不应标记为已暂存")
	}
}

/* ------------------------------------------------------------------ */
/* 分支与远端                                                          */
/* ------------------------------------------------------------------ */

func TestBranchesListsCurrent(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")
	gitRun(t, dir, "branch", "feature/x")

	branches, err := Branches(dir)
	if err != nil {
		t.Fatalf("列分支失败: %v", err)
	}
	if len(branches) != 2 {
		t.Fatalf("应有 2 个分支，实际 %d: %+v", len(branches), branches)
	}

	var current int
	for _, b := range branches {
		if b.Current {
			current++
			if b.Name != "main" {
				t.Errorf("当前分支应为 main，实际 %q", b.Name)
			}
		}
	}
	if current != 1 {
		t.Errorf("应恰有 1 个当前分支，实际 %d", current)
	}
}

// 没有远端时 ahead/behind 应为 0 而不是报错：本地仓库是常态。
func TestAheadBehindWithoutRemoteIsZero(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	ahead, behind, err := AheadBehind(dir)
	if err != nil {
		t.Fatalf("无远端不应报错: %v", err)
	}
	if ahead != 0 || behind != 0 {
		t.Errorf("无远端时应为 0/0，实际 %d/%d", ahead, behind)
	}
}

/* ------------------------------------------------------------------ */
/* 暂存与提交                                                          */
/* ------------------------------------------------------------------ */

func TestStageAndCommit(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "a.txt", "2\n")
	if err := Stage(dir, []string{"a.txt"}); err != nil {
		t.Fatalf("暂存失败: %v", err)
	}

	st, _ := RepoStatus(dir)
	for _, c := range st.Changes {
		if c.Path == "a.txt" && !c.Staged {
			t.Error("暂存后应标记为已暂存")
		}
	}

	if err := Commit(dir, "更新 a", false); err != nil {
		t.Fatalf("提交失败: %v", err)
	}
	st, _ = RepoStatus(dir)
	if st.Dirty {
		t.Error("提交后工作区应干净")
	}
}

func TestUnstageRestoresHead(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "a.txt", "2\n")
	_ = Stage(dir, []string{"a.txt"})
	if err := Unstage(dir, []string{"a.txt"}); err != nil {
		t.Fatalf("取消暂存失败: %v", err)
	}

	st, _ := RepoStatus(dir)
	for _, c := range st.Changes {
		if c.Path == "a.txt" {
			if c.Staged {
				t.Error("取消暂存后不应标记为已暂存")
			}
			return
		}
	}
	t.Fatal("a.txt 应仍在变更里（改动还在工作区）")
}

func TestCommitRequiresMessage(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	_ = Stage(dir, []string{"a.txt"})

	if err := Commit(dir, "   ", false); err == nil {
		t.Fatal("空提交信息应报错")
	}
}

// 没有任何暂存内容时提交必须失败，而不是产生一个空提交。
func TestCommitWithNothingStagedFails(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	if err := Commit(dir, "空提交", false); err == nil {
		t.Fatal("没有暂存内容时提交应失败")
	}
}

/* ------------------------------------------------------------------ */
/* diff                                                                */
/* ------------------------------------------------------------------ */

func TestFileDiffUnstaged(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "line1\nline2\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "a.txt", "line1\nchanged\n")

	d, err := FileDiff(dir, "a.txt", false)
	if err != nil {
		t.Fatalf("读 diff 失败: %v", err)
	}
	if !strings.Contains(d, "-line2") || !strings.Contains(d, "+changed") {
		t.Fatalf("diff 内容不对:\n%s", d)
	}
}

func TestFileDiffStaged(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "line1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "a.txt", "line1\nstaged\n")
	gitRun(t, dir, "add", "a.txt")

	d, err := FileDiff(dir, "a.txt", true)
	if err != nil {
		t.Fatalf("读 diff 失败: %v", err)
	}
	if !strings.Contains(d, "+staged") {
		t.Fatalf("暂存区 diff 应包含新增行:\n%s", d)
	}
}

// 未跟踪文件没有 HEAD 版本，diff 要能给出"整份都是新增"的形态，
// 而不是报错或返回空串——用户要能看到新文件内容。
func TestFileDiffUntrackedFile(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")
	write(t, dir, "new.txt", "brand new\n")

	d, err := FileDiff(dir, "new.txt", false)
	if err != nil {
		t.Fatalf("未跟踪文件的 diff 不应报错: %v", err)
	}
	if !strings.Contains(d, "brand new") {
		t.Fatalf("应给出新文件内容:\n%s", d)
	}
}

/* ------------------------------------------------------------------ */
/* 错误路径                                                            */
/* ------------------------------------------------------------------ */

func TestRepoStatusOutsideRepoFails(t *testing.T) {
	needGit(t)
	if _, err := RepoStatus(t.TempDir()); err == nil {
		t.Fatal("非仓库目录读状态应报错")
	}
}

func TestStageRejectsUnknownPath(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	// 通配符形式的未知路径不该被静默接受。
	if err := Stage(dir, []string{"definitely-not-here.txt"}); err == nil {
		t.Fatal("暂存不存在的文件应报错")
	}
}

// 每个文件的行数增删统计：列表层要直接给出改动量，
// 用户不必逐个点开才知道改了多少。
func TestRepoStatusIncludesLineStats(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "one\ntwo\nthree\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "a.txt", "one\nCHANGED\nthree\nFOUR\n")
	write(t, dir, "new.txt", "alpha\nbeta\n")

	st, err := RepoStatus(dir)
	if err != nil {
		t.Fatalf("读状态失败: %v", err)
	}

	byPath := map[string]Change{}
	for _, c := range st.Changes {
		byPath[c.Path] = c
	}

	a, ok := byPath["a.txt"]
	if !ok {
		t.Fatalf("应有 a.txt，实际 %v", keys2(st.Changes))
	}
	if a.Added != 2 || a.Removed != 1 {
		t.Errorf("a.txt 应为 +2/-1，实际 +%d/-%d", a.Added, a.Removed)
	}

	newFile, ok := byPath["new.txt"]
	if !ok {
		t.Fatalf("应有 new.txt，实际 %v", keys2(st.Changes))
	}
	if newFile.Added != 2 || newFile.Removed != 0 {
		t.Errorf("new.txt 应为 +2/-0，实际 +%d/-%d", newFile.Added, newFile.Removed)
	}
}

// 已暂存的改动，其统计要来自暂存区那一侧，否则列表会显示 0。
func TestRepoStatusStatsForStagedChanges(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "s.txt", "x\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	write(t, dir, "s.txt", "x\ny\nz\n")
	gitRun(t, dir, "add", "s.txt")

	st, err := RepoStatus(dir)
	if err != nil {
		t.Fatalf("读状态失败: %v", err)
	}

	var found bool
	for _, c := range st.Changes {
		if c.Path == "s.txt" {
			found = true
			if !c.Staged {
				t.Fatal("s.txt 应标记为已暂存")
			}
			if c.Added != 2 {
				t.Errorf("已暂存文件应显示 +2，实际 +%d", c.Added)
			}
		}
	}
	if !found {
		t.Fatal("应有 s.txt")
	}
}

// 二进制文件没有行数统计，不能让整个 status 失败。
func TestRepoStatusStatsTolerantOfBinary(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "keep.txt", "x\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	// 含 NUL 的文件会被 git 视为二进制。
	if err := os.WriteFile(filepath.Join(dir, "blob.bin"), []byte{0x00, 0x01, 0x02}, 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	st, err := RepoStatus(dir)
	if err != nil {
		t.Fatalf("二进制文件不应导致 status 失败: %v", err)
	}
	var found bool
	for _, c := range st.Changes {
		if c.Path == "blob.bin" {
			found = true
			// 二进制统计为 0/0，不报错即可。
		}
	}
	if !found {
		t.Fatalf("应列出 blob.bin，实际 %v", keys2(st.Changes))
	}
}

/* ------------------------------------------------------------------ */
/* 远端与 push                                                         */
/* ------------------------------------------------------------------ */

// newRemotePair 建一个本地裸仓库当"远端"，再 clone 一个工作副本出来。
//
// 用本地裸仓库而不是真的网络远端：push 的语义（refspec、upstream、
// 领先/落后计数）与远端类型无关，而联网会让测试变慢且不稳定。
func newRemotePair(t *testing.T) (workdir, remote string) {
	t.Helper()
	needGit(t)

	remote = t.TempDir()
	runAt(t, remote, "init", "--bare", "-b", "main")

	// 先造一个初始提交，否则 clone 出来是空仓库，push 没有上游可推。
	seed := t.TempDir()
	for _, args := range [][]string{
		{"init", "-b", "main"},
		{"config", "user.email", "seed@example.invalid"},
		{"config", "user.name", "Seed"},
		{"config", "core.autocrlf", "false"},
	} {
		runAt(t, seed, args...)
	}
	write(t, seed, "README.md", "# seed\n")
	runAt(t, seed, "add", ".")
	runAt(t, seed, "commit", "-m", "seed")
	runAt(t, seed, "remote", "add", "origin", remote)
	runAt(t, seed, "push", "-u", "origin", "main")

	// 再 clone 一份当用户的工作副本。
	workdir = t.TempDir()
	cloneTarget := filepath.Join(workdir, "clone")
	cmd := exec.Command("git", "clone", remote, cloneTarget)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("clone 失败: %v\n%s", err, out)
	}
	for _, args := range [][]string{
		{"config", "user.email", "user@example.invalid"},
		{"config", "user.name", "User"},
		{"config", "core.autocrlf", "false"},
	} {
		runAt(t, cloneTarget, args...)
	}
	return cloneTarget, remote
}

// runAt 在指定目录里跑 git，失败即终止测试。
func runAt(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s 失败: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

// push 之后本地应与远端持平（ahead 归零）。
func TestPushSendsCommitToRemote(t *testing.T) {
	dir, remote := newRemotePair(t)

	write(t, dir, "feature.txt", "hello\n")
	runAt(t, dir, "add", ".")
	runAt(t, dir, "commit", "-m", "add feature")

	ahead, _, err := AheadBehind(dir)
	if err != nil {
		t.Fatalf("读领先数失败: %v", err)
	}
	if ahead != 1 {
		t.Fatalf("提交后应领先 1，实际 %d", ahead)
	}

	if err := Push(dir, false); err != nil {
		t.Fatalf("push 失败: %v", err)
	}

	ahead, behind, err := AheadBehind(dir)
	if err != nil {
		t.Fatalf("读领先数失败: %v", err)
	}
	if ahead != 0 || behind != 0 {
		t.Fatalf("push 后应与远端持平，实际 %d/%d", ahead, behind)
	}

	// 远端确实收到了这个提交。
	out := runAt(t, remote, "rev-parse", "refs/heads/main")
	if strings.TrimSpace(out) == "" {
		t.Fatal("远端 main 应指向提交")
	}
	lsOut := runAt(t, remote, "ls-tree", "--name-only", "HEAD")
	if !strings.Contains(lsOut, "feature.txt") {
		t.Fatalf("远端应包含 feature.txt，实际 %s", lsOut)
	}
}

// 没有上游分支时 push 要给出可读错误，而不是让用户去猜。
func TestPushWithoutUpstreamFails(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	runAt(t, dir, "add", ".")
	runAt(t, dir, "commit", "-m", "init")

	err := Push(dir, false)
	if err == nil {
		t.Fatal("无上游时 push 应失败")
	}
	if !strings.Contains(err.Error(), "git push") {
		t.Fatalf("错误信息应包含失败的 git 命令，实际 %v", err)
	}
}

// 空仓库（还没提交）push 也要失败而不是静默成功。
func TestPushOnEmptyRepoFails(t *testing.T) {
	dir := newRepo(t)
	if err := Push(dir, false); err == nil {
		t.Fatal("没有提交时 push 应失败")
	}
}

// 强制 push 是破坏性操作，必须能被单独请求；普通 push 不应悄悄带上 force。
func TestPushForceFlagIsExplicit(t *testing.T) {
	dir, _ := newRemotePair(t)

	write(t, dir, "a.txt", "1\n")
	runAt(t, dir, "add", ".")
	runAt(t, dir, "commit", "-m", "one")
	if err := Push(dir, false); err != nil {
		t.Fatalf("首次 push 失败: %v", err)
	}

	// 改写历史后普通 push 会被拒绝——这正是要求用户显式确认的场景。
	write(t, dir, "a.txt", "2\n")
	runAt(t, dir, "add", ".")
	runAt(t, dir, "commit", "--amend", "-m", "amended")
	if err := Push(dir, false); err == nil {
		t.Fatal("改写历史后普通 push 应被拒绝")
	}
	// 显式 force 才能成功。
	if err := Push(dir, true); err != nil {
		t.Fatalf("强制 push 应成功: %v", err)
	}
}

// PushCommand 返回将要执行的命令，供确认框展示。
//
// 破坏性操作必须在确认框里显示完整命令——用户要能判断"我点下去会发生什么"。
func TestPushCommandIsInspectable(t *testing.T) {
	dir, _ := newRemotePair(t)
	write(t, dir, "a.txt", "1\n")
	runAt(t, dir, "add", ".")
	runAt(t, dir, "commit", "-m", "one")

	plain := PushCommand(dir, false)
	if !strings.Contains(plain, "git push") {
		t.Fatalf("应给出可读的 push 命令，实际 %q", plain)
	}
	if strings.Contains(plain, "--force") {
		t.Fatalf("普通 push 不应包含 --force，实际 %q", plain)
	}

	force := PushCommand(dir, true)
	if !strings.Contains(force, "--force-with-lease") {
		t.Fatalf("强制 push 应使用 --force-with-lease（比 --force 安全），实际 %q", force)
	}
}

// RemoteInfo 要给出"这个仓库 push 到哪里"，前端据此把本机目录关联到
// 服务端的仓库记录。没有上游时必须是空值而不是报错：仓库还没接远端是常态。
func TestRemoteInfoReportsUpstream(t *testing.T) {
	dir, remote := newRemotePair(t)

	info := RemoteInfo(dir)
	if info.Name != "origin" {
		t.Fatalf("应识别出上游远端名 origin，实际 %q", info.Name)
	}
	if info.URL == "" {
		t.Fatal("有上游时必须给出 remote 地址，否则前端无法解析 owner/repo")
	}
	if !strings.Contains(info.URL, remote) {
		t.Fatalf("remote 地址应指向那个裸仓库，实际 %q", info.URL)
	}
}

func TestRemoteInfoEmptyWithoutUpstream(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "a\n")
	runAt(t, dir, "add", ".")
	runAt(t, dir, "commit", "-m", "init")

	// 没有任何远端：两个字段都应为空，且不 panic。
	info := RemoteInfo(dir)
	if info.Name != "" || info.URL != "" {
		t.Fatalf("没有远端时应返回空值，实际 %+v", info)
	}
}

func keys(m map[string]Change) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func keys2(cs []Change) []string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.Path)
	}
	return out
}

var _ = runtime.GOOS
