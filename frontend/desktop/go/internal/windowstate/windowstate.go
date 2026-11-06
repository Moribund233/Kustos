// Package windowstate 负责保存与恢复窗口几何状态。
//
// 存下来不难，难的是"上次的位置现在还合理吗"：外接显示器被拔掉后，
// 上次的坐标落在不存在的屏幕上，窗口就开在用户看不见、也点不到的地方。
// 因此恢复时一律做可见性校正，而不是直接套用存下的数字。
//
// 本包刻意不依赖 Wails：几何判断是纯逻辑，能用普通单元测试覆盖，
// 屏幕列表由调用方从 Wails 查好后传进来。
package windowstate

import (
	"encoding/json"
	"fmt"

	"github.com/kustos/kustos-desktop/internal/store"
)

const (
	// DefaultWidth / DefaultHeight 是首次启动的窗口尺寸。
	// 桌面端面向大屏常驻使用，取比网页常见视口更宽的默认值。
	DefaultWidth  = 1440
	DefaultHeight = 900

	// MinWidth / MinHeight 是允许的最小尺寸。
	// 低于这个尺寸三栏布局会挤成一团，用户也无从把它拖回来。
	MinWidth  = 900
	MinHeight = 600

	// minVisible 是判定"窗口仍然可见"所需的最小重叠像素。
	// 取 100 而不是 1：只露一两个像素的窗口在视觉上等同于消失，
	// 但用户主动把窗口拖到屏幕边缘一半是常见操作，不能一律挪回去。
	minVisible = 100
)

// Rect 是屏幕或窗口的矩形（DIP 坐标）。
type Rect struct {
	X      int
	Y      int
	Width  int
	Height int
}

// State 是持久化的窗口状态。
type State struct {
	X         int  `json:"x"`
	Y         int  `json:"y"`
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	Maximised bool `json:"maximised"`
}

// Default 返回窗口的默认状态。
//
// 位置留 0 由窗口管理器自行安置：先给一个猜测的坐标再被系统覆盖，
// 反而会让窗口在启动瞬间跳一下。
func Default() State {
	return State{Width: DefaultWidth, Height: DefaultHeight}
}

// Save 持久化窗口状态。
//
// Args:
//
//	db:  本地库
//	key: 状态标识（如 "window.main"），一个窗口一个 key
//	s:   要保存的状态
//
// Returns:
//
//	写入失败时返回错误。调用方通常可以忽略该错误——窗口位置没存下来
//	不该阻止用户继续使用应用。
func Save(db *store.DB, key string, s State) error {
	raw, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("序列化窗口状态失败: %w", err)
	}
	return db.SetUIState(key, string(raw))
}

// Load 读取窗口状态。
//
// Returns:
//
//	状态、是否命中、错误。未命中或存储内容损坏时返回默认状态与 false；
//	损坏的数据不应该让界面起不来，所以这里不把解析失败当成错误上报。
func Load(db *store.DB, key string) (State, bool, error) {
	raw, ok, err := db.GetUIState(key)
	if err != nil {
		return Default(), false, err
	}
	if !ok {
		return Default(), false, nil
	}

	var s State
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return Default(), false, nil
	}
	if s.Width < MinWidth || s.Height < MinHeight {
		// 尺寸小于下限说明这条记录不可信（旧版本写坏、或被外部改过），
		// 与其把界面压成一条缝，不如退回默认值。
		return Default(), false, nil
	}
	return s, true, nil
}

// Restore 读取窗口状态并校正到当前屏幕布局。
//
// Args:
//
//	db:      本地库
//	key:     状态标识
//	screens: 当前可用屏幕的矩形列表（DIP）
//
// Returns:
//
//	可直接用于创建窗口的状态。尺寸会被收缩到能放进屏幕，
//	落在屏幕外的窗口会被挪到最近的屏幕中央；已是合理位置时原样保留。
//
// 传入空的屏幕列表时返回默认状态：此时无法判断任何坐标是否可见，
// 而"位置丢失"是可恢复的，"窗口开在看不见的地方"不是。
func Restore(db *store.DB, key string, screens []Rect) State {
	s, ok, err := Load(db, key)
	if err != nil || !ok {
		return Default()
	}
	if len(screens) == 0 {
		return Default()
	}

	maxW, maxH := 0, 0
	for _, sc := range screens {
		if sc.Width > maxW {
			maxW = sc.Width
		}
		if sc.Height > maxH {
			maxH = sc.Height
		}
	}

	if s.Width > maxW {
		s.Width = maxW
	}
	if s.Height > maxH {
		s.Height = maxH
	}
	if s.Width < MinWidth {
		s.Width = MinWidth
	}
	if s.Height < MinHeight {
		s.Height = MinHeight
	}
	// 屏幕本身比最小尺寸还小（极端缩放下）时，只能以屏幕为准。
	if s.Width > maxW {
		s.Width = maxW
	}
	if s.Height > maxH {
		s.Height = maxH
	}

	if isVisible(Rect{X: s.X, Y: s.Y, Width: s.Width, Height: s.Height}, screens) {
		return s
	}

	// 挪到离原位置最近的屏幕中央：比固定回主屏更接近用户预期，
	// 多屏环境下原窗口在副屏时不会被甩回主屏。
	target := nearestScreen(screens, s)
	s.X = target.X + (target.Width-s.Width)/2
	s.Y = target.Y + (target.Height-s.Height)/2
	return s
}

// isVisible 判断窗口在任一屏幕上是否有足够的可见部分。
func isVisible(w Rect, screens []Rect) bool {
	for _, sc := range screens {
		if overlap(w, sc) >= minVisible {
			return true
		}
	}
	return false
}

// overlap 返回两个矩形的重叠宽度与高度（无重叠时为 0）。
func overlap(a, b Rect) int {
	w := min(a.X+a.Width, b.X+b.Width) - max(a.X, b.X)
	if w < 0 {
		w = 0
	}
	h := min(a.Y+a.Height, b.Y+b.Height) - max(a.Y, b.Y)
	if h < 0 {
		h = 0
	}
	return min(w, h)
}

// nearestScreen 返回中心点离窗口中心最近的屏幕。
func nearestScreen(screens []Rect, s State) Rect {
	cx, cy := s.X+s.Width/2, s.Y+s.Height/2
	best := screens[0]
	bestDist := -1
	for _, sc := range screens {
		dx := sc.X + sc.Width/2 - cx
		dy := sc.Y + sc.Height/2 - cy
		dist := dx*dx + dy*dy
		if bestDist < 0 || dist < bestDist {
			best, bestDist = sc, dist
		}
	}
	return best
}
