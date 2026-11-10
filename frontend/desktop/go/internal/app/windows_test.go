package app

import (
	"strings"
	"testing"

	"github.com/kustos/kustos-desktop/internal/bridge"
)

// 窗口种类、状态 key 与关闭语义都是纯逻辑，值得单独钉住：
// 它们的错误不会让编译失败，只会让窗口开在错的位置、或者关窗直接退出应用。

func TestWindowStateKeyIsPerKind(t *testing.T) {
	mainKey := windowStateKey(WindowKindMain)
	reviewKey := windowStateKey(WindowKindReview)

	if mainKey == reviewKey {
		t.Fatalf("不同窗口必须各有自己的几何状态 key，实际都是 %q", mainKey)
	}
	// 主窗口的 key 是既有值：改了会让所有用户丢掉上次的窗口位置。
	if mainKey != "window.main" {
		t.Fatalf("主窗口 key 应保持 window.main，实际 %q", mainKey)
	}
}

func TestWindowStateKeyFallsBackToMain(t *testing.T) {
	// 未知种类必须回落到主窗口的 key，而不是造出一个没人读的孤儿键。
	if got := windowStateKey(WindowKind("nope")); got != "window.main" {
		t.Fatalf("未知种类应回落到主窗口 key，实际 %q", got)
	}
}

func TestHidableOnCloseOnlyForMain(t *testing.T) {
	// 主窗口关闭是"收进托盘"，评审窗关闭是真关闭。
	if !hidableOnClose(WindowKindMain) {
		t.Fatal("主窗口关闭应只隐藏，否则用户会被意外退出应用")
	}
	if hidableOnClose(WindowKindReview) {
		t.Fatal("评审窗关闭应真的关闭，隐藏会留下看不见的窗口")
	}
}

func TestParseWindowKindAcceptsKnownKinds(t *testing.T) {
	for _, raw := range []string{"main", "review"} {
		kind, err := parseWindowKind(raw)
		if err != nil {
			t.Fatalf("%q 应是合法种类，实际报错: %v", raw, err)
		}
		if string(kind) != raw {
			t.Fatalf("%q 解析结果应为自身，实际 %q", raw, kind)
		}
	}
}

func TestParseWindowKindRejectsUnknown(t *testing.T) {
	// 不做"就近猜一个"：打开用户没要求的窗口比报错更令人困惑。
	for _, raw := range []string{"", "MAIN", "settings", "review "} {
		if _, err := parseWindowKind(raw); err == nil {
			t.Fatalf("%q 不是合法种类，应报错", raw)
		}
	}
}

func TestRegistryStartsEmpty(t *testing.T) {
	r := newWindowRegistry()
	// 没有 app 实例时 existing 必须安全返回 nil，而不是 panic。
	if win := r.existing(nil, WindowKindReview); win != nil {
		t.Fatal("空注册表不应返回窗口")
	}
}

func TestRegistryMarkClosedThenOpen(t *testing.T) {
	r := newWindowRegistry()

	r.markClosed(WindowKindReview)
	if !r.closed[WindowKindReview] {
		t.Fatal("标记关闭后应记录在案")
	}
	// 已关闭的窗口不再复用：查询应返回 nil 而不是把它唤出来。
	if win := r.existing(nil, WindowKindReview); win != nil {
		t.Fatal("已关闭的窗口不应被复用")
	}

	r.markOpen(WindowKindReview)
	if r.closed[WindowKindReview] {
		t.Fatal("重新打开后应清除关闭标记")
	}
}

func TestTrayLabelsMergePartialUpdates(t *testing.T) {
	// 只下发部分字段时不该把其余文案清空：前端可能只更新一个语言下的
	// 某个名词，清空会让菜单出现空白项。
	tr := newTray()
	base := tr.labelsSnapshot()
	if base.ShowMain == "" || base.Quit == "" {
		t.Fatal("默认托盘文案不应为空")
	}

	tr.setLabels(trayLabels{ShowMain: "Open Kustos"})
	got := tr.labelsSnapshot()
	if got.ShowMain != "Open Kustos" {
		t.Fatalf("下发的字段应生效，实际 %q", got.ShowMain)
	}
	if got.Quit != base.Quit {
		t.Fatalf("未下发的字段应保留原值，实际 %q", got.Quit)
	}
	if got.Review != base.Review {
		t.Fatalf("未下发的字段应保留原值，实际 %q", got.Review)
	}
}

func TestTrayLabelsIgnoreEmptyStrings(t *testing.T) {
	tr := newTray()
	base := tr.labelsSnapshot()

	tr.setLabels(trayLabels{ShowMain: "", Review: "Review", Quit: ""})
	got := tr.labelsSnapshot()
	if got.ShowMain != base.ShowMain {
		t.Fatalf("空串不应覆盖已有文案，实际 %q", got.ShowMain)
	}
	if got.Review != "Review" {
		t.Fatalf("非空字段应生效，实际 %q", got.Review)
	}
}

// 托盘图标必须是 PNG：Wails 在 Windows 上按图片解码生成 HICON，
// 塞进别的格式会在运行期静默失败——图标区域空白而没有任何报错。
func TestTrayIconIsPNG(t *testing.T) {
	if len(trayIconPNG) < 8 {
		t.Fatal("托盘图标为空或过短")
	}
	pngMagic := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	for i, b := range pngMagic {
		if trayIconPNG[i] != b {
			t.Fatalf("托盘图标不是 PNG（第 %d 字节为 %#x）：非 PNG 会在 Windows 上静默不显示", i, trayIconPNG[i])
		}
	}
}

// 评审窗的内容标识要经 URL 片段传给前端，因此转义与拼接必须可测：
// 标识里出现斜杠或空格时，拼错的地址会让前端读到错误的 PR 编号，
// 而界面看起来只是"显示了另一个 PR"。
func TestWindowEntryURLCarriesRouteFragment(t *testing.T) {
	b, err := bridge.New("http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("创建 bridge 失败: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })

	d := &Desktop{bridge: b}

	entry, err := d.windowEntryURL("42")
	if err != nil {
		t.Fatalf("生成入口地址失败: %v", err)
	}
	if !strings.Contains(entry, "#/review/42") {
		t.Fatalf("入口地址应带上评审窗片段，实际 %q", entry)
	}
	// 令牌必须在片段之前：片段的解析优先级低于查询串，把令牌放片段里
	// 服务端根本读不到，窗口会白屏。
	query := strings.Index(entry, "__bridge=")
	fragment := strings.Index(entry, "#")
	if query < 0 || fragment < 0 || query > fragment {
		t.Fatalf("引导令牌必须出现在 URL 片段之前，实际 %q", entry)
	}
}

func TestWindowEntryURLEscapesRoute(t *testing.T) {
	b, err := bridge.New("http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("创建 bridge 失败: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })

	d := &Desktop{bridge: b}

	entry, err := d.windowEntryURL("a/b c")
	if err != nil {
		t.Fatalf("生成入口地址失败: %v", err)
	}
	// 斜杠与空格必须被转义，否则片段会被切成多段，前端解析出错误的编号。
	if strings.Contains(entry, "#/review/a/b") {
		t.Fatalf("斜杠应被转义，实际 %q", entry)
	}
	if strings.Contains(entry, " ") {
		t.Fatalf("空格应被转义，实际 %q", entry)
	}
}

func TestWindowEntryURLWithoutRouteHasNoFragment(t *testing.T) {
	b, err := bridge.New("http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("创建 bridge 失败: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })

	d := &Desktop{bridge: b}

	entry, err := d.windowEntryURL("")
	if err != nil {
		t.Fatalf("生成入口地址失败: %v", err)
	}
	if strings.Contains(entry, "#") {
		t.Fatalf("没有内容标识时不该带片段，实际 %q", entry)
	}
}

// 每个窗口各取一个新令牌：共用一个会让后开的窗口把前一个顶掉。
func TestWindowEntryURLIssuesDistinctTokens(t *testing.T) {
	b, err := bridge.New("http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("创建 bridge 失败: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })

	d := &Desktop{bridge: b}

	first, err := d.windowEntryURL("1")
	if err != nil {
		t.Fatalf("生成失败: %v", err)
	}
	second, err := d.windowEntryURL("2")
	if err != nil {
		t.Fatalf("生成失败: %v", err)
	}
	if first == second {
		t.Fatal("两次取入口地址应得到不同令牌")
	}
}
