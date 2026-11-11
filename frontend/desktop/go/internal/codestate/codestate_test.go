package codestate

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/kustos/kustos-desktop/internal/store"
)

// 布局恢复真正难的不是"把 JSON 存进去"，而是"存进去的那份还能用吗"：
// 用户可能在两次启动之间删了文件、改了目录名，也可能只剩半个标签条。
// 所以这里的重点是清洗与降级——坏数据只该少恢复一点，不该让 Code 面打不开。

func TestRoundTrip(t *testing.T) {
	db := newTestStore(t)

	want := State{
		WorkingCopyID: "abc123",
		Tabs:          []string{"src/lib/client.ts", "README.md"},
		ActivePath:    "README.md",
		Expanded:      []string{"src", "src/lib"},
	}
	if err := Save(db, want); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	got, ok, err := Load(db)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if !ok {
		t.Fatal("应命中")
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("往返不一致: 期望 %+v，实际 %+v", want, got)
	}
}

func TestLoadMissing(t *testing.T) {
	db := newTestStore(t)

	got, ok, err := Load(db)
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if ok {
		t.Fatalf("空库不应命中，实际 %+v", got)
	}
}

// 布局是每次改动都重写的 UI 数据，损坏的概率远高于配置。
// 读不出来就当没有，界面回到默认样子，而不是弹一个用户无法处理的错误。
func TestLoadCorruptValue(t *testing.T) {
	db := newTestStore(t)
	_ = db.SetUIState(Key, "{not json")

	got, ok, err := Load(db)
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if ok {
		t.Fatalf("损坏的布局不应命中，实际 %+v", got)
	}
}

// 没有仓库 id 的布局无处可施：路径相对的是仓库根，
// 套到当前仓库上指向的可能是完全不相干的文件。
func TestLoadWithoutWorkingCopyID(t *testing.T) {
	db := newTestStore(t)
	_ = db.SetUIState(Key, `{"tabs":["README.md"]}`)

	_, ok, err := Load(db)
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if ok {
		t.Fatal("缺仓库 id 时不应命中")
	}
}

// 当前文件不在标签条里时，界面会渲染出一个"活动标签不存在"的状态。
// 退到第一个标签是可预期的降级。
func TestNormalizeFallsBackToFirstTab(t *testing.T) {
	got := Normalize(State{
		WorkingCopyID: "abc123",
		Tabs:          []string{"a.ts", "b.ts"},
		ActivePath:    "missing.ts",
	})

	if got.ActivePath != "a.ts" {
		t.Fatalf("应退到第一个标签，实际 %q", got.ActivePath)
	}
}

func TestNormalizeOnEmptyTabs(t *testing.T) {
	got := Normalize(State{WorkingCopyID: "abc123", ActivePath: "a.ts"})

	if len(got.Tabs) != 0 {
		t.Fatalf("不应凭空造出标签，实际 %v", got.Tabs)
	}
	if got.ActivePath != "" {
		t.Fatalf("没有标签时当前文件应为空，实际 %q", got.ActivePath)
	}
}

func TestNormalizeDropsBlankAndDuplicate(t *testing.T) {
	got := Normalize(State{
		WorkingCopyID: " abc123 ",
		Tabs:          []string{" a.ts ", "", "a.ts", "b.ts", "   "},
		Expanded:      []string{"src", "src", "", " "},
	})

	wantTabs := []string{"a.ts", "b.ts"}
	if !reflect.DeepEqual(got.Tabs, wantTabs) {
		t.Fatalf("标签清洗不符: 期望 %v，实际 %v", wantTabs, got.Tabs)
	}
	wantExpanded := []string{"src"}
	if !reflect.DeepEqual(got.Expanded, wantExpanded) {
		t.Fatalf("目录清洗不符: 期望 %v，实际 %v", wantExpanded, got.Expanded)
	}
	if got.WorkingCopyID != "abc123" {
		t.Fatalf("仓库 id 应去空白，实际 %q", got.WorkingCopyID)
	}
}

// 上限之外的部分直接丢弃：布局每改一次整份重写，
// 一份几百 KB 的 UI 状态没有意义。
func TestNormalizeTruncates(t *testing.T) {
	tabs := make([]string, 0, maxTabs+10)
	for i := 0; i < maxTabs+10; i++ {
		tabs = append(tabs, fmt.Sprintf("f%d.ts", i))
	}
	expanded := make([]string, 0, maxExpanded+10)
	for i := 0; i < maxExpanded+10; i++ {
		expanded = append(expanded, fmt.Sprintf("d%d", i))
	}

	got := Normalize(State{WorkingCopyID: "abc123", Tabs: tabs, Expanded: expanded})

	if len(got.Tabs) != maxTabs {
		t.Fatalf("标签应截断到 %d，实际 %d", maxTabs, len(got.Tabs))
	}
	if len(got.Expanded) != maxExpanded {
		t.Fatalf("目录应截断到 %d，实际 %d", maxExpanded, len(got.Expanded))
	}
	// 截断后活动标签被推出上限时，同样要退回第一个。
	if got.ActivePath != got.Tabs[0] {
		t.Fatalf("截断后当前文件应落在标签内，实际 %q", got.ActivePath)
	}
}

// 保存前也走清洗：调用方不必记得先 Normalize 一遍。
func TestSaveNormalizes(t *testing.T) {
	db := newTestStore(t)

	if err := Save(db, State{WorkingCopyID: "abc123", Tabs: []string{" a.ts ", "a.ts"}}); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	got, ok, err := Load(db)
	if err != nil || !ok {
		t.Fatalf("应命中，err=%v ok=%v", err, ok)
	}
	wantTabs := []string{"a.ts"}
	if !reflect.DeepEqual(got.Tabs, wantTabs) {
		t.Fatalf("保存时应清洗，实际 %v", got.Tabs)
	}
}

// 只认这一个键：布局是单份状态，多键会让恢复逻辑出现"该读哪个"的分支。
func TestSaveWritesSingleKey(t *testing.T) {
	db := newTestStore(t)

	if err := Save(db, State{WorkingCopyID: "abc123"}); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	if _, ok, err := db.GetUIState(Key); err != nil || !ok {
		t.Fatalf("应写入 %q，err=%v ok=%v", Key, err, ok)
	}
}

func newTestStore(t *testing.T) *store.DB {
	t.Helper()
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
