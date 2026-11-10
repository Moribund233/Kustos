package services

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kustos/kustos-desktop/internal/store"
)

// WorkingCopyService 的职责边界：它把"本机工作树的状态"翻译成结构化数据，
// 但**不做任何权限或合并策略判断**——那些回服务端。
//
// 测试用真实临时仓库：这层最容易出错的地方就是 git 调用与路径处理，
// mock 掉 git 等于把最有价值的断言换成对自己想象的断言。

func needGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过真实仓库测试")
	}
}

func newTestWorkingCopyService(t *testing.T) *WorkingCopyService {
	t.Helper()
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewWorkingCopyService(db)
}

// initRepo 建一个临时 git 仓库。
func initRepo(t *testing.T) string {
	t.Helper()
	needGit(t)
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-b", "main"},
		{"config", "user.email", "test@example.invalid"},
		{"config", "user.name", "Test"},
		{"config", "core.autocrlf", "false"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s 失败: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	return dir
}

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s 失败: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func writeFile(t *testing.T, dir, name, content string) {
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
/* 添加与列出                                                          */
/* ------------------------------------------------------------------ */

func TestAddRejectsNonRepository(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	plain := t.TempDir()

	if _, err := svc.Add(plain); err == nil {
		t.Fatal("非仓库目录应被拒绝")
	}
}

func TestAddRejectsMissingPath(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	missing := filepath.Join(t.TempDir(), "nope")

	if _, err := svc.Add(missing); err == nil {
		t.Fatal("不存在的路径应被拒绝")
	}
}

func TestAddRegistersRepository(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	wc, err := svc.Add(dir)
	if err != nil {
		t.Fatalf("添加失败: %v", err)
	}
	if wc.ID == "" {
		t.Fatal("应生成 ID")
	}
	if wc.Branch != "main" {
		t.Errorf("分支 = %q", wc.Branch)
	}
	if wc.Path == "" {
		t.Fatal("应记录路径")
	}
	if wc.Dirty {
		t.Error("刚提交完不应为 dirty")
	}
}

// 同一目录添加两次必须得到同一条记录：用户不该在列表里看到两个相同条目。
func TestAddIsIdempotentByPath(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	first, err := svc.Add(dir)
	if err != nil {
		t.Fatalf("首次添加失败: %v", err)
	}
	second, err := svc.Add(dir)
	if err != nil {
		t.Fatalf("重复添加失败: %v", err)
	}

	if first.ID != second.ID {
		t.Fatalf("同一路径应复用 ID: %q vs %q", first.ID, second.ID)
	}
	list, err := svc.List()
	if err != nil {
		t.Fatalf("列出失败: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("应只有 1 条，实际 %d", len(list))
	}
}

// 从仓库子目录添加，记录的应是仓库根而不是子目录——
// 否则后续 status/diff 的路径基准会错。
func TestAddFromSubdirectoryRecordsRoot(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "pkg/a.txt", "1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	wc, err := svc.Add(filepath.Join(dir, "pkg"))
	if err != nil {
		t.Fatalf("添加失败: %v", err)
	}

	root, err := filepath.EvalSymlinks(wc.Path)
	if err != nil {
		root = wc.Path
	}
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		want = dir
	}
	if root != want {
		t.Fatalf("应记录仓库根 %q，实际 %q", want, root)
	}
}

func TestListReturnsEmptySlice(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	list, err := svc.List()
	if err != nil {
		t.Fatalf("列出失败: %v", err)
	}
	if list == nil {
		t.Fatal("应为空切片而非 nil")
	}
}

func TestRemoveDeletesRecord(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	wc, _ := svc.Add(dir)
	if err := svc.Remove(wc.ID); err != nil {
		t.Fatalf("移除失败: %v", err)
	}

	list, _ := svc.List()
	if len(list) != 0 {
		t.Fatalf("移除后应为空，实际 %d", len(list))
	}
	// 只删记录，不碰磁盘：用户不期望"从列表移除"等于删掉目录。
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("移除记录不应删除工作树: %v", err)
	}
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

func TestStatusReturnsChanges(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	wc, _ := svc.Add(dir)
	writeFile(t, dir, "a.txt", "2\n")
	writeFile(t, dir, "new.txt", "x\n")

	st, err := svc.Status(wc.ID)
	if err != nil {
		t.Fatalf("读状态失败: %v", err)
	}
	if !st.Dirty {
		t.Error("有改动时应为 dirty")
	}
	if len(st.Changes) != 2 {
		t.Fatalf("应有 2 个变更，实际 %d: %+v", len(st.Changes), st.Changes)
	}
}

// 读取状态要把快照写回本地库：列表页要能直接显示"脏/干净"，
// 否则每次渲染都得为每个仓库跑一次 git status。
func TestStatusUpdatesSnapshot(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	wc, _ := svc.Add(dir)
	writeFile(t, dir, "a.txt", "2\n")

	if _, err := svc.Status(wc.ID); err != nil {
		t.Fatalf("读状态失败: %v", err)
	}

	reloaded, _ := svc.List()
	if len(reloaded) != 1 || !reloaded[0].Dirty {
		t.Fatalf("快照应更新为 dirty，实际 %+v", reloaded)
	}
	if reloaded[0].LastScanAt == 0 {
		t.Error("应记录扫描时间")
	}
}

// 工作树被用户在终端里删掉后，读状态应给出可读错误而不是崩溃。
func TestStatusOnMissingWorkingTree(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	wc, _ := svc.Add(dir)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("删除目录失败: %v", err)
	}

	if _, err := svc.Status(wc.ID); err == nil {
		t.Fatal("工作树不存在时应报错")
	}
}

func TestStatusUnknownIDFails(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	if _, err := svc.Status("nope"); err == nil {
		t.Fatal("未知 ID 应报错")
	}
}

/* ------------------------------------------------------------------ */
/* 暂存与提交                                                          */
/* ------------------------------------------------------------------ */

func TestStageAndCommitViaService(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	wc, _ := svc.Add(dir)
	writeFile(t, dir, "a.txt", "2\n")

	if err := svc.Stage(wc.ID, []string{"a.txt"}); err != nil {
		t.Fatalf("暂存失败: %v", err)
	}
	if err := svc.Commit(wc.ID, "更新 a", false); err != nil {
		t.Fatalf("提交失败: %v", err)
	}

	st, _ := svc.Status(wc.ID)
	if st.Dirty {
		t.Error("提交后应干净")
	}
}

func TestCommitRequiresMessage(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	wc, _ := svc.Add(dir)
	if err := svc.Commit(wc.ID, "   ", false); err == nil {
		t.Fatal("空提交信息应被拒绝")
	}
}

func TestStageUnknownIDFails(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	if err := svc.Stage("nope", []string{"a.txt"}); err == nil {
		t.Fatal("未知 ID 应报错")
	}
}

/* ------------------------------------------------------------------ */
/* 远端同步                                                            */
/* ------------------------------------------------------------------ */

// newRemoteBackedService 建一个带本地裸远端的服务与工作副本。
//
// 用本地裸仓库而不是真网络：push 的语义（refspec、upstream、领先/落后）
// 与远端类型无关，联网只会让测试变慢且不稳定。
func newRemoteBackedService(t *testing.T) (*WorkingCopyService, string) {
	t.Helper()
	needGit(t)

	remote := t.TempDir()
	runGit(t, remote, "init", "--bare", "-b", "main")

	seed := t.TempDir()
	for _, args := range [][]string{
		{"init", "-b", "main"},
		{"config", "user.email", "seed@example.invalid"},
		{"config", "user.name", "Seed"},
		{"config", "core.autocrlf", "false"},
	} {
		runGit(t, seed, args...)
	}
	writeFile(t, seed, "README.md", "# seed\n")
	runGit(t, seed, "add", ".")
	runGit(t, seed, "commit", "-m", "seed")
	runGit(t, seed, "remote", "add", "origin", remote)
	runGit(t, seed, "push", "-u", "origin", "main")

	parent := t.TempDir()
	clonePath := filepath.Join(parent, "clone")
	cmd := exec.Command("git", "clone", remote, clonePath)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("clone 失败: %v\n%s", err, out)
	}
	for _, args := range [][]string{
		{"config", "user.email", "user@example.invalid"},
		{"config", "user.name", "User"},
		{"config", "core.autocrlf", "false"},
	} {
		runGit(t, clonePath, args...)
	}

	svc := newTestWorkingCopyService(t)
	wc, err := svc.Add(clonePath)
	if err != nil {
		t.Fatalf("添加工作副本失败: %v", err)
	}
	return svc, wc.ID
}

// runGit 在目录里跑 git，失败即终止。
func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s 失败: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

// Push 之后状态里的领先数应归零。
func TestPushViaService(t *testing.T) {
	svc, id := newRemoteBackedService(t)

	wc, _, _ := svc.store.GetWorkingCopy(id)
	writeFile(t, wc.Path, "new.txt", "hello\n")
	runGit(t, wc.Path, "add", ".")
	runGit(t, wc.Path, "commit", "-m", "add new")

	if err := svc.Push(id, false); err != nil {
		t.Fatalf("push 失败: %v", err)
	}

	st, err := svc.Status(id)
	if err != nil {
		t.Fatalf("读状态失败: %v", err)
	}
	if st.Ahead != 0 {
		t.Fatalf("push 后领先数应为 0，实际 %d", st.Ahead)
	}
}

func TestPushUnknownIDFails(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	if err := svc.Push("nope", false); err == nil {
		t.Fatal("未知 ID 应报错")
	}
}

// PushCommand 供确认框展示：破坏性操作必须让用户看到完整命令。
func TestPushCommandViaService(t *testing.T) {
	svc, id := newRemoteBackedService(t)

	cmd, err := svc.PushCommand(id, true)
	if err != nil {
		t.Fatalf("取命令失败: %v", err)
	}
	if !strings.Contains(cmd, "git push") || !strings.Contains(cmd, "--force-with-lease") {
		t.Fatalf("命令不对: %q", cmd)
	}
}

// 在编辑器中打开：路径不存在时服务层要给出明确错误而不是静默成功。
func TestOpenInEditorMissingFile(t *testing.T) {
	svc, id := newRemoteBackedService(t)

	if err := svc.OpenInEditor(id, "definitely-missing.txt"); err == nil {
		t.Fatal("不存在的文件应报错")
	}
}

// 路径穿越必须被拒绝：前端传来的相对路径不能跑出仓库根。
func TestOpenInEditorRejectsPathTraversal(t *testing.T) {
	svc, id := newRemoteBackedService(t)

	for _, bad := range []string{"../../../etc/passwd", "/etc/passwd", "..\\..\\windows\\system32"} {
		if err := svc.OpenInEditor(id, bad); err == nil {
			t.Errorf("越界路径 %q 应被拒绝", bad)
		}
	}
}

/* ------------------------------------------------------------------ */
/* diff                                                                */
/* ------------------------------------------------------------------ */

func TestFileDiffViaService(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "old\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	wc, _ := svc.Add(dir)
	writeFile(t, dir, "a.txt", "new\n")

	d, err := svc.FileDiff(wc.ID, "a.txt", false)
	if err != nil {
		t.Fatalf("读 diff 失败: %v", err)
	}
	if !strings.Contains(d, "+new") {
		t.Fatalf("diff 内容不对:\n%s", d)
	}
}

func TestBranchesViaService(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	wc, _ := svc.Add(dir)
	branches, err := svc.Branches(wc.ID)
	if err != nil {
		t.Fatalf("列分支失败: %v", err)
	}
	if len(branches) != 1 || branches[0].Name != "main" || !branches[0].Current {
		t.Fatalf("分支列表不对: %+v", branches)
	}
}

/* ------------------------------------------------------------------ */
/* 远端关联                                                            */
/* ------------------------------------------------------------------ */

// RemoteInfo 是"本机工作副本 ↔ 服务端仓库"之间唯一的桥梁：
// PR 与 Issue 面靠它给出的 remote 地址推导 owner/repo。
func TestRemoteInfoReturnsUpstream(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")
	gitIn(t, dir, "remote", "add", "origin", "https://kustos.example.com/octo/kustos.git")

	wc, err := svc.Add(dir)
	if err != nil {
		t.Fatalf("添加失败: %v", err)
	}

	info, err := svc.RemoteInfo(wc.ID)
	if err != nil {
		t.Fatalf("读取远端信息失败: %v", err)
	}
	if info.URL != "https://kustos.example.com/octo/kustos.git" {
		t.Fatalf("remote 地址不对: %q", info.URL)
	}
	// 没有配置上游分支时远端名可能为空；地址必须能取到才算可用。
	if info.URL == "" {
		t.Fatal("取不到 remote 地址时前端无法关联服务端仓库")
	}
}

func TestRemoteInfoEmptyWithoutRemote(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	wc, err := svc.Add(dir)
	if err != nil {
		t.Fatalf("添加失败: %v", err)
	}

	// 仓库还没接远端是常态，不该报错。
	info, err := svc.RemoteInfo(wc.ID)
	if err != nil {
		t.Fatalf("没有远端时不应报错: %v", err)
	}
	if info.Name != "" || info.URL != "" {
		t.Fatalf("没有远端时应返回空值，实际 %+v", info)
	}
}

func TestRemoteInfoRejectsUnknownID(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	if _, err := svc.RemoteInfo("no-such-copy"); err == nil {
		t.Fatal("未知工作副本 ID 应报错")
	}
}
