package windowstate

import (
	"testing"

	"github.com/kustos/kustos-desktop/internal/store"
)

// 窗口状态持久化最容易出事的不是"存下来"，而是"存下来的位置现在还合理吗"：
// 外接显示器拔掉后，上次的位置落在不存在的屏幕上，窗口就开在用户看不见的地方。
// 因此这里的重点测试是恢复时的可见性校正。

func TestRoundTrip(t *testing.T) {
	db := newTestStore(t)

	want := State{X: 120, Y: 80, Width: 1440, Height: 900, Maximised: true}
	if err := Save(db, "window.main", want); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	got, ok, err := Load(db, "window.main")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if !ok {
		t.Fatal("应命中")
	}
	if got != want {
		t.Fatalf("往返不一致: 期望 %+v，实际 %+v", want, got)
	}
}

func TestLoadMissingReturnsDefault(t *testing.T) {
	db := newTestStore(t)

	got, ok, err := Load(db, "window.main")
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if ok {
		t.Fatalf("首次启动不应命中，实际 %+v", got)
	}
	// 没有记录时给的是可用默认值，而不是零值窗口（0×0 在多数平台不可见）。
	if got.Width < MinWidth || got.Height < MinHeight {
		t.Fatalf("默认值过小: %+v", got)
	}
}

// 写入损坏的 JSON 时不能把界面卡死：退回默认值并报告可恢复。
func TestLoadCorruptValueFallsBackToDefault(t *testing.T) {
	db := newTestStore(t)
	_ = db.SetUIState("window.main", "{not json")

	got, ok, err := Load(db, "window.main")
	if err != nil {
		t.Fatalf("损坏数据不应报错: %v", err)
	}
	if ok {
		t.Error("损坏数据不应视为有效记录")
	}
	if got.Width < MinWidth {
		t.Fatalf("应退回默认值，实际 %+v", got)
	}
}

// 核心用例：上次的位置在已拔掉的显示器上，恢复时必须挪回可见区域。
func TestRestoreMovesOffscreenWindowBack(t *testing.T) {
	db := newTestStore(t)
	// x=9000 远在任何屏幕之外，模拟外接显示器被拔掉。
	_ = Save(db, "window.main", State{X: 9000, Y: 8000, Width: 1440, Height: 900})

	// 只有一块 1920×1080 的主屏。
	screens := []Rect{{X: 0, Y: 0, Width: 1920, Height: 1080}}
	got := Restore(db, "window.main", screens)

	if !rectsIntersect(Rect{X: got.X, Y: got.Y, Width: got.Width, Height: got.Height}, screens[0]) {
		t.Fatalf("窗口必须落在某块屏幕内，实际 %+v", got)
	}
	// 尺寸仍应保留：用户只期望位置被纠正，不是窗口被重置。
	if got.Width != 1440 || got.Height != 900 {
		t.Fatalf("尺寸应保留，实际 %+v", got)
	}
}

// 尺寸超过当前屏幕时收缩，否则窗口会永远有一部分拖不回来。
func TestRestoreClampsOversizedWindow(t *testing.T) {
	db := newTestStore(t)
	_ = Save(db, "window.main", State{X: 0, Y: 0, Width: 4000, Height: 3000})

	screens := []Rect{{X: 0, Y: 0, Width: 1920, Height: 1080}}
	got := Restore(db, "window.main", screens)

	if got.Width > 1920 || got.Height > 1080 {
		t.Fatalf("尺寸应收缩到屏幕内，实际 %+v", got)
	}
}

// 窗口只要还有一部分可见就应保住位置：用户把窗口部分移出屏幕是常见主动行为。
func TestRestoreKeepsPartiallyVisibleWindow(t *testing.T) {
	db := newTestStore(t)
	_ = Save(db, "window.main", State{X: 1800, Y: 100, Width: 1440, Height: 900})

	screens := []Rect{{X: 0, Y: 0, Width: 1920, Height: 1080}}
	got := Restore(db, "window.main", screens)

	if got.X != 1800 || got.Y != 100 {
		t.Fatalf("部分可见应保留原位置，实际 %+v", got)
	}
}

// 多屏环境下，位于副屏的窗口不能被误挪回主屏。
func TestRestoreKeepsWindowOnSecondaryScreen(t *testing.T) {
	db := newTestStore(t)
	_ = Save(db, "window.main", State{X: 2400, Y: 200, Width: 1200, Height: 800})

	screens := []Rect{
		{X: 0, Y: 0, Width: 1920, Height: 1080},
		{X: 1920, Y: 0, Width: 1920, Height: 1080},
	}
	got := Restore(db, "window.main", screens)

	if got.X != 2400 || got.Y != 200 {
		t.Fatalf("副屏窗口不应被挪动，实际 %+v", got)
	}
}

// 没有任何屏幕信息时（无头环境、初始查询失败）不能崩，也不能把窗口算到 NaN 位置。
func TestRestoreWithoutScreenInfoKeepsDefaults(t *testing.T) {
	db := newTestStore(t)
	_ = Save(db, "window.main", State{X: 100, Y: 100, Width: 1440, Height: 900})

	got := Restore(db, "window.main", nil)

	if got.Width < MinWidth || got.Height < MinHeight {
		t.Fatalf("应退回默认值，实际 %+v", got)
	}
}

// rectsIntersect 判断两个矩形是否有任何重叠，供断言使用。
func rectsIntersect(a, b Rect) bool {
	return min(a.X+a.Width, b.X+b.Width) > max(a.X, b.X) &&
		min(a.Y+a.Height, b.Y+b.Height) > max(a.Y, b.Y)
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
