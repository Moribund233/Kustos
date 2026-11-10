package app

import (
	"fmt"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// WindowKind 标识桌面端的一种窗口。
//
// 用字符串常量而不是枚举整数：窗口种类要出现在前端调用参数里（`OpenWindow("review")`），
// 字符串让绑定层与日志都可读，也不必为新增种类重新生成数字。
type WindowKind string

const (
	// WindowKindMain 是主窗口：三栏工作台，关闭时收进托盘。
	WindowKindMain WindowKind = "main"
	// WindowKindReview 是评审窗：第二个窗口，关闭即真的关闭。
	WindowKindReview WindowKind = "review"
)

// windowKeys 是每种窗口在本地库里的状态 key。
//
// 每个窗口各自一份几何：评审窗常被拖到第二块屏并保持与主窗口不同的尺寸，
// 共用一个 key 会让每次开关窗口都互相覆盖对方的位置。
var windowKeys = map[WindowKind]string{
	WindowKindMain:   "window.main",
	WindowKindReview: "window.review",
}

// windowStateKey 返回某个窗口种类的状态 key。
//
// Args:
//
//	kind: 窗口种类
//
// Returns:
//
//	本地库里的 key；未知种类回落到主窗口的 key，避免多出一个无人读取的孤儿键。
func windowStateKey(kind WindowKind) string {
	if key, ok := windowKeys[kind]; ok {
		return key
	}
	return windowKeys[WindowKindMain]
}

// hidableOnClose 判断某类窗口的关闭动作是否只收起而不销毁。
//
// 主窗口收起后应用仍在托盘里常驻——用户按窗口的关闭键表达的是"先放一边"，
// 不是"退出程序"，退出是托盘菜单里的显式动作。评审窗没有独立存活的理由，
// 关闭就真的关掉。
//
// Args:
//
//	kind: 窗口种类
//
// Returns:
//
//	关闭时应当隐藏（而非销毁）时为 true。
func hidableOnClose(kind WindowKind) bool {
	return kind == WindowKindMain
}

// parseWindowKind 把前端传来的字符串收敛为已知的窗口种类。
//
// Args:
//
//	raw: 前端传入的种类标识
//
// Returns:
//
//	已知种类；无法识别时返回错误。这里不做"就近猜一个"：
//	打开一个用户没要求的窗口比报错更令人困惑。
func parseWindowKind(raw string) (WindowKind, error) {
	switch WindowKind(raw) {
	case WindowKindMain:
		return WindowKindMain, nil
	case WindowKindReview:
		return WindowKindReview, nil
	default:
		return "", fmt.Errorf("未知的窗口种类: %q", raw)
	}
}

// windowRegistry 按 Name 复用窗口，保证同一种窗口只存在一个实例。
//
// 为什么必须复用而不是重复创建：Wails 的 NewWithOptions 每次都造新窗口，
// 用户连点两次"在窗口打开"就会得到两个评审窗，各自持有独立的 DOM 与状态，
// 关闭其中一个不会影响另一个。按 Name 查已有实例才是用户预期的行为。
type windowRegistry struct {
	mu sync.Mutex
	// closed 记录被判为"已关闭"的窗口，用于在查询时区分"窗口还在但已隐藏"。
	// 隐藏的主窗口仍然是活的，必须能被再次唤出，所以不能靠 Visible 判断存活。
	closed map[WindowKind]bool
}

// newWindowRegistry 构造窗口注册表。
func newWindowRegistry() *windowRegistry {
	return &windowRegistry{closed: make(map[WindowKind]bool)}
}

// existing 返回已存在的窗口。
//
// Args:
//
//	app: Wails 应用实例
//	kind: 窗口种类
//
// Returns:
//
//	已存在且未被销毁的窗口；不存在时为 nil。
func (r *windowRegistry) existing(app *application.App, kind WindowKind) *application.WebviewWindow {
	if app == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed[kind] {
		return nil
	}
	win, ok := app.Window.GetByName(string(kind))
	if !ok {
		return nil
	}
	// Wails 的窗口在销毁后仍可能短暂留在管理器里，取到名字不代表能用。
	webview, ok := win.(*application.WebviewWindow)
	if !ok || webview == nil {
		return nil
	}
	return webview
}

// markClosed 记录某个窗口已被关闭，下次创建时不再复用。
func (r *windowRegistry) markClosed(kind WindowKind) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed[kind] = true
}

// markOpen 记录某个窗口已被打开。
func (r *windowRegistry) markOpen(kind WindowKind) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.closed, kind)
}

// windowEventTypes 是触发几何持久化的窗口事件。
//
// 拖动与缩放会连续触发上百次，因此这些都只登记一次待保存（由 windowstate.Saver
// 去抖），而不是逐次写库。
var windowEventTypes = []events.WindowEventType{
	events.Common.WindowDidMove,
	events.Common.WindowDidResize,
	events.Common.WindowMaximise,
	events.Common.WindowUnMaximise,
	events.Common.WindowRestore,
}
