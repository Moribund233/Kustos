package app

import (
	"github.com/kustos/kustos-desktop/internal/windowstate"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// systemScreens 返回当前所有屏幕的工作区矩形（DIP）。
//
// 用 WorkArea 而不是 Bounds：任务栏与程序坞占掉的部分不该被算进可用区域，
// 否则窗口会被恢复到任务栏底下。
//
// 查询失败或返回空列表时返回 nil，由 windowstate 退回默认状态——
// 屏幕信息不可得时，"位置丢失"是可恢复的，"窗口开在看不见的地方"不是。
func systemScreens() []windowstate.Rect {
	screens := application.Get().Screen.GetAll()
	if len(screens) == 0 {
		return nil
	}

	out := make([]windowstate.Rect, 0, len(screens))
	for _, sc := range screens {
		wa := sc.WorkArea
		// WorkArea 在某些平台上可能未填充，退回整块屏幕。
		if wa.Width <= 0 || wa.Height <= 0 {
			wa = sc.Bounds
		}
		out = append(out, windowstate.Rect{
			X:      wa.X,
			Y:      wa.Y,
			Width:  wa.Width,
			Height: wa.Height,
		})
	}
	return out
}
