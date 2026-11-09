package services

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/kustos/kustos-desktop/internal/store"
)

// 编辑器的写盘路径：读回原文与 mtime、写回、冲突检测、崩溃恢复。
//
// 这一层最容易出错的不是"能不能写"，而是"什么时候**不该**写"：
// 静默覆盖别人的修改、把已保存的内容又当成待恢复的草稿提出来，
// 这类问题不会在正常路径上暴露，只能靠用例守住。

// newFileService 建一个带真实仓库的 service。
func newFileService(t *testing.T) (*WorkingCopyService, string, string) {
	t.Helper()
	svc := newTestWorkingCopyService(t)
	dir := initRepo(t)
	// 初始提交：让工作树处于可比较的状态。
	writeFile(t, dir, "hello.txt", "hello\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-m", "init")

	wc, err := svc.Add(dir)
	if err != nil {
		t.Fatalf("添加工作副本失败: %v", err)
	}
	return svc, wc.ID, dir
}

func TestReadTextReturnsMtime(t *testing.T) {
	svc, id, _ := newFileService(t)

	got, err := svc.ReadText(id, "hello.txt")
	if err != nil {
		t.Fatalf("读文件失败: %v", err)
	}
	if got.Content != "hello\n" {
		t.Errorf("内容 = %q", got.Content)
	}
	if got.Mtime == 0 {
		t.Error("mtime 不能为 0：写回时要用它做冲突检测")
	}
	if got.Size != int64(len("hello\n")) {
		t.Errorf("size = %d", got.Size)
	}
}

// ReadText 与 ReadFile 的边界应当一致：二进制与超大文件都拒绝。
func TestReadTextRejectsBinary(t *testing.T) {
	svc, id, dir := newFileService(t)
	abs := filepath.Join(dir, "blob.bin")
	if err := os.WriteFile(abs, []byte{0x00, 0x01, 0x02, 0x00}, 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	if _, err := svc.ReadText(id, "blob.bin"); err == nil {
		t.Fatal("二进制文件不应被当作文本打开")
	}
}

func TestWriteTextWritesAndReturnsNewMtime(t *testing.T) {
	svc, id, dir := newFileService(t)

	before, err := svc.ReadText(id, "hello.txt")
	if err != nil {
		t.Fatalf("读文件失败: %v", err)
	}

	newMtime, err := svc.WriteText(id, "hello.txt", "changed\n", before.Mtime)
	if err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	abs := filepath.Join(dir, "hello.txt")
	data, err := os.ReadFile(abs)
	if err != nil {
		t.Fatalf("读取写回的文件失败: %v", err)
	}
	if string(data) != "changed\n" {
		t.Errorf("磁盘内容 = %q", string(data))
	}
	if newMtime == before.Mtime {
		t.Error("写回后 mtime 应当变化")
	}
}

// 磁盘在读取之后被改过时**必须拒绝写入**，否则会静默覆盖别人的修改。
func TestWriteTextRejectsStaleMtime(t *testing.T) {
	svc, id, dir := newFileService(t)

	before, err := svc.ReadText(id, "hello.txt")
	if err != nil {
		t.Fatalf("读文件失败: %v", err)
	}

	// 模拟外部修改：直接改磁盘并确保 mtime 变化。
	abs := filepath.Join(dir, "hello.txt")
	if err := os.WriteFile(abs, []byte("someone else\n"), 0o644); err != nil {
		t.Fatalf("外部写入失败: %v", err)
	}
	bumpMtime(t, abs)

	_, err = svc.WriteText(id, "hello.txt", "my edit\n", before.Mtime)
	if !errors.Is(err, ErrFileChanged) {
		t.Fatalf("期望 ErrFileChanged，实际: %v", err)
	}

	// 关键断言：外部内容必须还在，没有被覆盖。
	data, err := os.ReadFile(abs)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if string(data) != "someone else\n" {
		t.Errorf("外部修改被覆盖了，磁盘内容 = %q", string(data))
	}
}

// expectedMtime 传 0 表示用户明确选择"强制保存"。
func TestWriteTextAllowsForcedSave(t *testing.T) {
	svc, id, dir := newFileService(t)

	if _, err := svc.WriteText(id, "hello.txt", "forced\n", 0); err != nil {
		t.Fatalf("强制保存应当成功: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "hello.txt"))
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if string(data) != "forced\n" {
		t.Errorf("内容 = %q", string(data))
	}
}

// 写回要保留原文件的权限位：改一个可执行脚本不该弄丢执行位。
//
// Windows 上 os.Chmod 只影响只读位，权限位恒定，因此这个断言只在
// POSIX 平台上有意义；在 Windows 上跳过而不是改成永远成立的空断言。
func TestWriteTextPreservesFileMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 不保留 POSIX 权限位")
	}
	svc, id, dir := newFileService(t)
	abs := filepath.Join(dir, "script.sh")
	if err := os.WriteFile(abs, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	if _, err := svc.WriteText(id, "script.sh", "#!/bin/sh\necho hi\n", 0); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	info, err := os.Stat(abs)
	if err != nil {
		t.Fatalf("读取状态失败: %v", err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Errorf("权限 = %v，期望 0755", info.Mode().Perm())
	}
}

// 临时文件不能残留：用户仓库里积攒一堆 .kustos-* 是很明显的缺陷。
func TestWriteTextLeavesNoTempFiles(t *testing.T) {
	svc, id, dir := newFileService(t)

	if _, err := svc.WriteText(id, "hello.txt", "x\n", 0); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读目录失败: %v", err)
	}
	for _, e := range entries {
		if len(e.Name()) > 8 && e.Name()[:8] == ".kustos-" {
			t.Errorf("残留临时文件: %s", e.Name())
		}
	}
}

// 路径越界必须拒绝，写盘路径与读取路径共用同一套校验。
func TestWriteTextRejectsOutsideRepo(t *testing.T) {
	svc, id, _ := newFileService(t)

	if _, err := svc.WriteText(id, "../outside.txt", "nope\n", 0); err == nil {
		t.Fatal("越界路径不应被写入")
	}
}

func TestStatTextReportsMissingFile(t *testing.T) {
	svc, id, _ := newFileService(t)

	// 文件不存在是正常情形，不该是错误。
	got, err := svc.StatText(id, "nope.txt")
	if err != nil {
		t.Fatalf("文件不存在不应报错: %v", err)
	}
	if got.Exists {
		t.Error("Exists 应为 false")
	}
}

func TestStatTextReportsExistingFile(t *testing.T) {
	svc, id, _ := newFileService(t)

	got, err := svc.StatText(id, "hello.txt")
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if !got.Exists || got.Mtime == 0 {
		t.Errorf("状态 = %+v", got)
	}
}

/* ------------------------------------------------------------------ */
/* 崩溃恢复                                                            */
/* ------------------------------------------------------------------ */

func TestDraftSurvivesAndLists(t *testing.T) {
	svc, id, _ := newFileService(t)

	if err := svc.SaveDraft(id, "hello.txt", "unsaved edit\n", 12345); err != nil {
		t.Fatalf("保存草稿失败: %v", err)
	}

	drafts, err := svc.ListDrafts(id)
	if err != nil {
		t.Fatalf("列出草稿失败: %v", err)
	}
	if len(drafts) != 1 {
		t.Fatalf("草稿数 = %d", len(drafts))
	}
	d := drafts[0]
	if d.Path != "hello.txt" || d.Content != "unsaved edit\n" || d.BaseMtime != 12345 {
		t.Errorf("草稿 = %+v", d)
	}
	if d.SavedAt == 0 {
		t.Error("savedAt 应当被填上")
	}
}

// 保存成功后草稿必须消失，否则下次启动会把已落盘的内容当成待恢复改动。
func TestWriteTextClearsDraft(t *testing.T) {
	svc, id, _ := newFileService(t)

	if err := svc.SaveDraft(id, "hello.txt", "edit\n", 0); err != nil {
		t.Fatalf("保存草稿失败: %v", err)
	}
	if _, err := svc.WriteText(id, "hello.txt", "edit\n", 0); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	drafts, err := svc.ListDrafts(id)
	if err != nil {
		t.Fatalf("列出草稿失败: %v", err)
	}
	if len(drafts) != 0 {
		t.Fatalf("保存后草稿应被清除，实际还有 %d 条", len(drafts))
	}
}

func TestDiscardDraftRemovesIt(t *testing.T) {
	svc, id, _ := newFileService(t)

	if err := svc.SaveDraft(id, "hello.txt", "edit\n", 0); err != nil {
		t.Fatalf("保存草稿失败: %v", err)
	}
	if err := svc.DiscardDraft(id, "hello.txt"); err != nil {
		t.Fatalf("放弃草稿失败: %v", err)
	}

	drafts, err := svc.ListDrafts(id)
	if err != nil {
		t.Fatalf("列出草稿失败: %v", err)
	}
	if len(drafts) != 0 {
		t.Errorf("草稿数 = %d", len(drafts))
	}
}

// 移除工作副本时草稿要一起清掉：它们永远等不到对应的仓库。
func TestRemoveClearsDrafts(t *testing.T) {
	svc, id, _ := newFileService(t)

	if err := svc.SaveDraft(id, "hello.txt", "edit\n", 0); err != nil {
		t.Fatalf("保存草稿失败: %v", err)
	}
	if err := svc.Remove(id); err != nil {
		t.Fatalf("移除工作副本失败: %v", err)
	}

	// 工作副本没了，但草稿表里不该再有它的记录。
	drafts, err := svc.store.ListBufferRecoveries(id)
	if err != nil {
		t.Fatalf("查询草稿失败: %v", err)
	}
	if len(drafts) != 0 {
		t.Errorf("草稿数 = %d", len(drafts))
	}
}

// 草稿只属于它自己的工作副本。
func TestDraftsAreScopedPerWorkingCopy(t *testing.T) {
	svc := newTestWorkingCopyService(t)

	dirA := initRepo(t)
	dirB := initRepo(t)
	writeFile(t, dirA, "a.txt", "a\n")
	writeFile(t, dirB, "b.txt", "b\n")

	wcA, err := svc.Add(dirA)
	if err != nil {
		t.Fatalf("添加 A 失败: %v", err)
	}
	wcB, err := svc.Add(dirB)
	if err != nil {
		t.Fatalf("添加 B 失败: %v", err)
	}

	if err := svc.SaveDraft(wcA.ID, "a.txt", "draft a\n", 0); err != nil {
		t.Fatalf("保存 A 草稿失败: %v", err)
	}

	draftsB, err := svc.ListDrafts(wcB.ID)
	if err != nil {
		t.Fatalf("列出 B 草稿失败: %v", err)
	}
	if len(draftsB) != 0 {
		t.Errorf("B 不该看到 A 的草稿，实际 %d 条", len(draftsB))
	}
}

// store 层的 upsert 语义：同一文件重复保存只留一条。
func TestSaveDraftOverwritesSamePath(t *testing.T) {
	svc, id, _ := newFileService(t)

	if err := svc.SaveDraft(id, "hello.txt", "first\n", 0); err != nil {
		t.Fatalf("保存草稿失败: %v", err)
	}
	if err := svc.SaveDraft(id, "hello.txt", "second\n", 0); err != nil {
		t.Fatalf("保存草稿失败: %v", err)
	}

	drafts, err := svc.ListDrafts(id)
	if err != nil {
		t.Fatalf("列出草稿失败: %v", err)
	}
	if len(drafts) != 1 {
		t.Fatalf("草稿数 = %d", len(drafts))
	}
	if drafts[0].Content != "second\n" {
		t.Errorf("内容 = %q", drafts[0].Content)
	}
}

// bumpMtime 把文件的修改时间往后推，确保与之前读到的值不同。
//
// 有些文件系统的时间精度只有秒级，连续两次写入可能落在同一个 tick 上，
// 那样"冲突检测"用例就会因为 mtime 恰好相等而假通过。
func bumpMtime(t *testing.T, abs string) {
	t.Helper()
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatalf("读取状态失败: %v", err)
	}
	future := info.ModTime().Add(2 * time.Second)
	if err := os.Chtimes(abs, future, future); err != nil {
		t.Fatalf("调整 mtime 失败: %v", err)
	}
}

// 确保 store 包被引用（草稿查询在测试里直接用到了 store 类型）。
var _ = store.BufferRecovery{}
