package services

import (
	"errors"
	"sync"
)

// errNotWired 表示该能力尚未被装配层接上。
//
// 明确报"没接线"而不是静默成功：一个点了没反应的按钮，排查起来比一条
// 说清原因的错误难得多。
var errNotWired = errors.New("桌面端能力未接线")

// 窗口后端是一组由装配层注入的动作。
//
// 为什么用包级变量而不是给 WindowService 加 Wire 方法：绑定生成器会把服务上
// **所有导出的方法**都变成前端可调用的接口，`Wire` 一旦是方法，前端就能调用它
// 去改写本机的窗口后端——那等于把装配层的一个内部接线动作暴露成了远程接口。
// 包级函数不在生成的绑定里。
//
// 用包级变量在这里是可接受的：桌面端是单进程单实例应用，窗口后端天然只有一份，
// 不存在多实例共享一个进程的场景。
var (
	backendMu     sync.RWMutex
	backendOpen   func(kind string) error
	backendOpenWith func(kind, route string) error
	backendClose  func() error
	backendGet    func() (show, review, quit, tooltip string)
	backendSet    func(show, review, quit, tooltip string)
)

// BindWindowBackend 接上窗口与托盘的实现。
//
// 必须在 app.Run() 之前调用：托盘在启动后立刻可用，晚于它接线会让托盘菜单
// 在前几百毫秒里点了没反应。
//
// Args:
//
//	open:         打开指定种类的窗口
//	closeCurrent: 关闭当前窗口
//	trayGet:      读取托盘当前文案
//	traySet:      更新托盘文案；空串表示保留原值
func BindWindowBackend(
	open func(kind string) error,
	openWith func(kind, route string) error,
	closeCurrent func() error,
	trayGet func() (show, review, quit, tooltip string),
	traySet func(show, review, quit, tooltip string),
) {
	backendMu.Lock()
	defer backendMu.Unlock()
	backendOpen = open
	backendOpenWith = openWith
	backendClose = closeCurrent
	backendGet = trayGet
	backendSet = traySet
}

// WindowService 是窗口与托盘的控制面。
//
// 边界：它只回答"本机现在能不能再开一个窗口、托盘文案是什么"，
// **不做任何业务判断**——窗口里放什么内容、用户能看哪个 PR，仍由服务端裁决。
type WindowService struct{}

// NewWindowService 构造窗口服务。
//
// Returns:
//
//	可交给绑定生成器的服务实例。实现由 BindWindowBackend 注入。
func NewWindowService() *WindowService {
	return &WindowService{}
}

// WindowInfo 是一次托盘文案快照。
type WindowInfo struct {
	ShowMain string `json:"showMain"`
	Review   string `json:"review"`
	Quit     string `json:"quit"`
	Tooltip  string `json:"tooltip"`
}

// OpenWindow 打开指定种类的窗口。
//
// 已存在时把它唤到前面，不重复创建：每种窗口只应有一个实例，
// 否则连点两次会得到两个各自持有独立状态的窗口。
//
// Args:
//
//	kind: 窗口种类，取值 main 或 review
//
// Returns:
//
//	种类无法识别、创建失败或后端未接线时返回错误。
func (s *WindowService) OpenWindow(kind string) error {
	return s.OpenWindowWith(kind, "")
}

// OpenWindowWith 打开指定种类的窗口并指定它要显示的内容。
//
// 评审窗不是主窗口的副本：它要显示"哪一个 PR"。内容标识经 URL 片段传给前端，
// 而不是靠全局状态——多窗口下全局状态由最后写入者胜出，两个评审窗会显示
// 同一个 PR，而它们本该各看各的。
//
// Args:
//
//	kind:  窗口种类，取值 main 或 review
//	route: 内容标识（如 PR 编号 "42"）；空串表示不带
//
// Returns:
//
//	种类无法识别、创建失败或后端未接线时返回错误。
func (s *WindowService) OpenWindowWith(kind, route string) error {
	backendMu.RLock()
	openWith := backendOpenWith
	backendMu.RUnlock()

	if openWith != nil {
		return openWith(kind, route)
	}

	// 后端只接了不带内容的版本时，退化为"只开窗口"。
	backendMu.RLock()
	open := backendOpen
	backendMu.RUnlock()
	if open == nil {
		return errNotWired
	}
	return open(kind)
}

// CloseCurrentWindow 关闭当前窗口。
//
// 主窗口的关闭是"收进托盘"而非退出应用：用户按窗口的关闭键表达的是
// 先放一边，退出由托盘菜单显式发起。
//
// Returns:
//
//	关闭失败或后端未接线时返回错误。
func (s *WindowService) CloseCurrentWindow() error {
	backendMu.RLock()
	closeCurrent := backendClose
	backendMu.RUnlock()

	if closeCurrent == nil {
		return errNotWired
	}
	return closeCurrent()
}

// TrayLabels 返回托盘当前文案，供界面按当前语言同步。
//
// Returns:
//
//	托盘四个文案字段的快照；后端未接线时各字段为空。
func (s *WindowService) TrayLabels() WindowInfo {
	backendMu.RLock()
	get := backendGet
	backendMu.RUnlock()

	if get == nil {
		return WindowInfo{}
	}
	show, review, quit, tooltip := get()
	return WindowInfo{ShowMain: show, Review: review, Quit: quit, Tooltip: tooltip}
}

// SetTrayLabels 更新托盘菜单文案。
//
// 语言切换后调用一次即可：菜单项支持就地改标签，不必重建整个菜单
// （重建会让已经展开的菜单闪一下）。
//
// Args:
//
//	labels: 新文案；空字段保留原值（只下发部分字段时不该把其余清空）
func (s *WindowService) SetTrayLabels(labels WindowInfo) {
	backendMu.RLock()
	set := backendSet
	backendMu.RUnlock()

	if set == nil {
		return
	}
	set(labels.ShowMain, labels.Review, labels.Quit, labels.Tooltip)
}
