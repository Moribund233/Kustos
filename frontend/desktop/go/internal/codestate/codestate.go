// Package codestate 负责保存与恢复 Code 面的布局状态。
//
// 存的是"用户离开时打开了什么"：标签页顺序、当前文件、展开了哪些目录。
// 崩溃恢复（`store.BufferRecovery`）保的是未保存的**内容**，这里保的是
// 布局，两者互补——只恢复内容而丢掉标签页，重开时用户还得自己找回去。
//
// 与 windowstate 一样刻意不依赖 Wails：数据形状与清洗是纯逻辑，
// 能用普通单元测试覆盖。
//
// 存下来的路径一律是相对仓库根的斜杠路径，与 `WorkingCopyService` 的约定
// 一致。本包不校验路径是否还在仓库里：文件被删、目录改名都是常态，
// 恢复时读不到就只是少一个标签，不该让整个布局失效。
package codestate

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/kustos/kustos-desktop/internal/store"
)

// Key 是布局在 `ui_state` 里的键。
//
// 只存一份：Code 面同一时刻只显示一个工作副本，布局里带着仓库 id，
// 切仓库时对不上就整份作废。按仓库分别存会让删掉的工作副本留下
// 永远读不到的记录，而 `ui_state` 没有过期清理。
const Key = "code.layout"

const (
	// maxTabs 是保留的标签页上限。
	// 用户能开多少标签没有硬约束，但布局是每次改动都要整份重写的 JSON，
	// 无上限意味着一份能长到几百 KB 的 UI 状态。
	maxTabs = 50

	// maxExpanded 是保留的展开目录上限。
	// 正常浏览远到不了这个量级，超出说明记录已经不可信。
	maxExpanded = 500
)

// State 是持久化的 Code 面布局。
type State struct {
	// WorkingCopyID 是这份布局所属的工作副本。
	// 切换仓库后旧布局不能套到新仓库上——路径相对的是仓库根，
	// 换个仓库同名路径指向的是另一个文件。
	WorkingCopyID string `json:"workingCopyId"`
	// Tabs 是标签页的路径，顺序即显示顺序。
	Tabs []string `json:"tabs"`
	// ActivePath 是离开时正在看的那个。
	ActivePath string `json:"activePath"`
	// Expanded 是展开的目录路径。
	Expanded []string `json:"expanded"`
}

// Save 持久化布局。
//
// Args:
//
//	db: 本地库
//	s:  要保存的布局（会先做一次清洗）
//
// Returns:
//
//	写入失败时返回错误。调用方通常可以忽略——布局没存下来不该打断用户。
func Save(db *store.DB, s State) error {
	raw, err := json.Marshal(Normalize(s))
	if err != nil {
		return fmt.Errorf("序列化布局状态失败: %w", err)
	}
	return db.SetUIState(Key, string(raw))
}

// Load 读取布局。
//
// Returns:
//
//	布局、是否命中、错误。未命中、内容损坏或没有仓库 id 时返回空状态与
//	false：布局坏掉只该让界面回到默认样子，不该阻止它启动。
func Load(db *store.DB) (State, bool, error) {
	raw, ok, err := db.GetUIState(Key)
	if err != nil {
		return State{}, false, err
	}
	if !ok {
		return State{}, false, nil
	}

	var s State
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return State{}, false, nil
	}
	s = Normalize(s)
	// 没有仓库 id 的布局无处可施：套到当前仓库上是猜的。
	if s.WorkingCopyID == "" {
		return State{}, false, nil
	}
	return s, true, nil
}

// Normalize 清洗一份布局，让它可以直接喂给界面。
//
// Returns:
//
//	路径去空白、去重、截断到上限，并把 ActivePath 收到 Tabs 之内。
//
// 前端传来的路径源于用户操作，重名与失效都有可能；在边界处收敛一次，
// 恢复逻辑就不用到处设防。
func Normalize(s State) State {
	out := State{WorkingCopyID: trimSpace(s.WorkingCopyID)}

	seen := make(map[string]bool, len(s.Tabs))
	for _, p := range s.Tabs {
		p = trimSpace(p)
		// 空路径不是文件，留着只会渲染出一个空标签。
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		out.Tabs = append(out.Tabs, p)
		if len(out.Tabs) >= maxTabs {
			break
		}
	}

	expanded := make(map[string]bool, len(s.Expanded))
	for _, p := range s.Expanded {
		p = trimSpace(p)
		if p == "" || expanded[p] {
			continue
		}
		expanded[p] = true
		out.Expanded = append(out.Expanded, p)
		if len(out.Expanded) >= maxExpanded {
			break
		}
	}

	// 当前文件必须是打开的标签之一。对不上时退回第一个标签：
	// 与其恢复出一个"活动标签不在标签条里"的状态，不如从最左边开始。
	out.ActivePath = trimSpace(s.ActivePath)
	if !seen[out.ActivePath] {
		out.ActivePath = ""
		if len(out.Tabs) > 0 {
			out.ActivePath = out.Tabs[0]
		}
	}
	return out
}

// trimSpace 去掉首尾空白。
func trimSpace(s string) string {
	return strings.TrimSpace(s)
}
