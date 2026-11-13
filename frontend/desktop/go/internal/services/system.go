package services

import (
	"errors"
	"sync"

	"github.com/kustos/kustos-desktop/internal/git"
)

// errPickerNotWired 表示目录选择框还没接上系统实现。
//
// 与窗口服务同一处境：真实实现在 app 包（要 Wails 的 Dialog 管理器，
// 而它要等 application.New 之后才有值），服务对象先构造、后端后回填。
var errPickerNotWired = errors.New("目录选择暂不可用")

var (
	pickerMu   sync.RWMutex
	pickFolder func(title, start string) (string, error)
)

// BindDirectoryPicker 接上系统目录选择框的实现。
//
// 用包级绑定函数而不是服务方法，理由与 BindWindowBackend 相同：
// Wails 会把服务的每个导出方法都变成前端可调用的绑定，"接线"本身
// 不该是一条 RPC。
func BindDirectoryPicker(pick func(title, start string) (string, error)) {
	pickerMu.Lock()
	defer pickerMu.Unlock()
	pickFolder = pick
}

// currentPicker 返回已接上的目录选择实现。
func currentPicker() func(title, start string) (string, error) {
	pickerMu.RLock()
	defer pickerMu.RUnlock()
	return pickFolder
}

// GitStatus 描述本机 git 的可用性。
type GitStatus struct {
	// Available 表示找得到 git 且能跑起来。
	Available bool `json:"available"`
	// Version 是解析后的版本号，形如 "2.55.0.windows.5"。
	Version string `json:"version"`
	// Error 是失败原因；可用时为空。
	Error string `json:"error"`
}

// SystemService 提供本机能力探测与系统对话框。
//
// 边界：它只回答"这台机器能不能干活"，不涉及任何实例或仓库状态。
type SystemService struct{}

// NewSystemService 构造系统能力服务。
func NewSystemService() *SystemService {
	return &SystemService{}
}

// GitStatus 报告本机 git 是否可用。
//
// 为什么单独成一条：桌面端不内置 git，所有读写都调系统 git。用户机器上
// 没有 git 时，报错会出现在"克隆"那一刻，看起来像是网络或权限问题；
// 在引导页先问一次，就能直接说"请先安装 git"。
//
// Returns:
//
//	可用性与版本；不可用时 Error 带原因，不抛错（界面要能照常渲染）。
func (s *SystemService) GitStatus() GitStatus {
	version, err := git.Version()
	if err != nil {
		return GitStatus{Available: false, Error: err.Error()}
	}
	return GitStatus{Available: true, Version: version}
}

// PickDirectory 打开系统目录选择框并返回用户选中的绝对路径。
//
// Args:
//
//	title: 对话框标题
//	start: 起始目录；为空则由系统决定
//
// Returns:
//
//	选中的目录；用户取消时返回空字符串与 nil（取消不是错误）。
func (s *SystemService) PickDirectory(title, start string) (string, error) {
	pick := currentPicker()
	if pick == nil {
		return "", errPickerNotWired
	}
	return pick(title, start)
}
