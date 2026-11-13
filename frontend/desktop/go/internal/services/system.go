package services

import (
	"errors"
	"fmt"
	"os"
	"sync"

	"github.com/kustos/kustos-desktop/internal/git"
	"github.com/kustos/kustos-desktop/internal/platform/shellreg"
)

// errPickerNotWired 表示目录选择框还没接上系统实现。
//
// 与窗口服务同一处境：真实实现在 app 包（要 Wails 的 Dialog 管理器，
// 而它要等 application.New 之后才有值），服务对象先构造、后端后回填。
var errPickerNotWired = errors.New("目录选择暂不可用")

var (
	pickerMu   sync.RWMutex
	pickFolder func(title, start string) (string, error)

	deeplinkMu      sync.RWMutex
	pendingSurface_ func() string
)

// BindPendingSurface 接上"启动期深链目标"的读取实现。
//
// 用包级绑定函数而不是服务方法，理由与 BindDirectoryPicker 相同：真实实现
// 在 app 包（要读装配层攒下的待消费目标），而"接线"本身不该是一条 RPC。
func BindPendingSurface(read func() string) {
	deeplinkMu.Lock()
	defer deeplinkMu.Unlock()
	pendingSurface_ = read
}

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

// PendingSurface 返回启动时收到、还没被界面消费的深链目标分区。
//
// Returns:
//
//	`inbox` / `working-copy` / `code` / `pulls` / `issues`；没有时为
//	空串。读一次就清空——它不是"当前分区"，而是"还没处理的一次导航"。
//
// 为什么界面要在启动时问一次：深链可能在窗口刚创建、前端还没注册事件监听
// 时到达，那时 Go 侧的广播没有任何接收者，这一次导航就丢了。
func (s *SystemService) PendingSurface() string {
	deeplinkMu.RLock()
	read := pendingSurface_
	deeplinkMu.RUnlock()
	if read == nil {
		return ""
	}
	return read()
}

// SystemIntegration 描述本程序在系统里的注册现状。
type SystemIntegration struct {
	// ExePath 是本进程可执行文件的绝对路径。
	ExePath string `json:"exePath"`
	// ProtocolRegistered 表示 `kustos://` 已注册且指向本进程。
	ProtocolRegistered bool `json:"protocolRegistered"`
	// Autostart 表示开机自启已开启且指向本进程。
	Autostart bool `json:"autostart"`
	// Error 是查询失败的原因；正常时为空。
	Error string `json:"error"`
}

// IntegrationStatus 报告深链协议与开机自启的注册现状。
//
// Returns:
//
//	注册现状快照。读不到可执行文件路径时 Error 带原因，其余字段为零值——
//	界面要能照常渲染，而不是整块空掉。
func (s *SystemService) IntegrationStatus() SystemIntegration {
	exe, err := os.Executable()
	if err != nil {
		return SystemIntegration{Error: fmt.Sprintf("找不到本程序路径: %v", err)}
	}
	return SystemIntegration{
		ExePath:            exe,
		ProtocolRegistered: shellreg.ProtocolRegistered(shellreg.Scheme, exe),
		Autostart:          shellreg.AutostartEnabled(exe),
	}
}

// SetAutostart 开启或关闭开机自启。
//
// Args:
//
//	enabled: true 写入启动项，false 移除
//
// Returns:
//
//	写注册表失败时返回错误（界面据此说"没设置成功"，而不是显示一个假的开关）。
func (s *SystemService) SetAutostart(enabled bool) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("找不到本程序路径: %w", err)
	}
	return shellreg.SetAutostart(enabled, exe)
}

// RegisterProtocol 把本程序注册为 `kustos://` 的处理器。
//
// Returns:
//
//	写注册表失败时返回错误。
//
// 界面不自动调它：往注册表里写协议处理器是一次可观察的系统改动，应当由用户
// 显式点一次（设置页里的"注册深链"），而不是装完就悄悄写。
func (s *SystemService) RegisterProtocol() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("找不到本程序路径: %w", err)
	}
	return shellreg.RegisterProtocol(shellreg.Scheme, exe)
}

// UnregisterProtocol 移除 `kustos://` 的注册。
//
// Returns:
//
//	写注册表失败时返回错误；本来就没注册时返回 nil。
func (s *SystemService) UnregisterProtocol() error {
	return shellreg.UnregisterProtocol(shellreg.Scheme)
}
