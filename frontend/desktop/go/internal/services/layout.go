package services

import (
	"fmt"

	"github.com/kustos/kustos-desktop/internal/codestate"
)

// CodeLayout 是 Code 面布局的扁平 DTO。
//
// 直接给前端用的类型，所以不暴露 internal 结构体：绑定生成器会把这里的
// 字段原样变成 TS 定义，字段名一旦泄漏内部命名就改不动了。
type CodeLayout struct {
	WorkingCopyID string   `json:"workingCopyId"`
	Tabs          []string `json:"tabs"`
	ActivePath    string   `json:"activePath"`
	Expanded      []string `json:"expanded"`
}

// LoadCodeLayout 读取上次离开 Code 面时的布局。
//
// Returns:
//
//	布局与错误。从未保存过、或保存的内容已不可用时返回零值布局而不是错误：
//	布局恢复是锦上添花，读不到就该安静地从空白开始。
func (s *WorkingCopyService) LoadCodeLayout() (CodeLayout, error) {
	st, ok, err := codestate.Load(s.store)
	if err != nil {
		return CodeLayout{}, fmt.Errorf("读取布局状态失败: %w", err)
	}
	if !ok {
		return CodeLayout{}, nil
	}
	return CodeLayout{
		WorkingCopyID: st.WorkingCopyID,
		Tabs:          append([]string(nil), st.Tabs...),
		ActivePath:    st.ActivePath,
		Expanded:      append([]string(nil), st.Expanded...),
	}, nil
}

// SaveCodeLayout 保存 Code 面布局。
//
// Args:
//
//	layout: 当前打开的工作副本、标签页、当前文件与展开目录
//
// Returns:
//
//	工作副本不存在或写入失败时返回错误。调用方可以忽略失败——存不下布局
//	不影响用户继续编辑。
func (s *WorkingCopyService) SaveCodeLayout(layout CodeLayout) error {
	// 布局挂在具体仓库上：路径相对仓库根，没有仓库就无从谈起。
	// 顺带校验工作副本还在，已删除的仓库不该继续产出布局记录。
	if _, err := s.get(layout.WorkingCopyID); err != nil {
		return err
	}

	st := codestate.State{
		WorkingCopyID: layout.WorkingCopyID,
		Tabs:          layout.Tabs,
		ActivePath:    layout.ActivePath,
		Expanded:      layout.Expanded,
	}
	if err := codestate.Save(s.store, st); err != nil {
		return fmt.Errorf("保存布局状态失败: %w", err)
	}
	return nil
}
