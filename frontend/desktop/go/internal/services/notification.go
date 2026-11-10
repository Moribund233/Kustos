package services

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// notifyBackend 是系统通知的注入点。
//
// 用接口而不是直接持有 Wails 的通知服务：那个服务在 Wails 启动之后才可用，
// 而服务对象在装配期就要能构造；接口也让校验逻辑能在不起 GUI 的前提下单测。
type notifyBackend interface {
	// Send 发出一条通知。
	Send(options notifications.NotificationOptions) error
	// RequestAuthorization 申请通知权限。
	RequestAuthorization() (bool, error)
	// CheckAuthorization 查询通知权限。
	CheckAuthorization() (bool, error)
}

// wailsNotifier 是 notifyBackend 的真实实现，包住 Wails 的通知服务。
type wailsNotifier struct {
	svc *notifications.NotificationService
}

func (w wailsNotifier) Send(options notifications.NotificationOptions) error {
	return w.svc.SendNotification(options)
}

func (w wailsNotifier) RequestAuthorization() (bool, error) {
	return w.svc.RequestNotificationAuthorization()
}

func (w wailsNotifier) CheckAuthorization() (bool, error) {
	return w.svc.CheckNotificationAuthorization()
}

var (
	notifyMu    sync.RWMutex
	notifyImpl  notifyBackend
)

// BindNotifier 接上系统通知的实现。
//
// 必须在 app.Run() 之前调用：通知服务在 Wails 启动时完成初始化，
// 晚于它接线会让第一批通知静默失败。
//
// Args:
//
//	svc: Wails 的通知服务实例；传 nil 表示不接
func BindNotifier(svc *notifications.NotificationService) {
	if svc == nil {
		return
	}
	notifyMu.Lock()
	defer notifyMu.Unlock()
	notifyImpl = wailsNotifier{svc: svc}
}

// currentNotifier 返回当前的通知后端；未接线时为 nil。
func currentNotifier() notifyBackend {
	notifyMu.RLock()
	defer notifyMu.RUnlock()
	return notifyImpl
}

// NotificationRequest 是一条要发出的系统通知。
//
// 由界面组装后下发，而不是 Go 侧自己判断"什么事值得打扰用户"：待我决策的
// 语义取决于目标当前状态（PR 是否仍待审、Issue 是否指派给我），那由服务端
// 裁决；桌面端只负责把已经决定的事推到系统通知里。
type NotificationRequest struct {
	// ID 是通知标识，同一 ID 的新通知会替换掉旧的那条。
	ID string `json:"id"`
	// Title 是通知标题，不能为空。
	Title string `json:"title"`
	// Body 是正文，可为空。
	Body string `json:"body"`
	// ThreadID 把相关通知归到一组（同一 PR 的评论堆叠在一起）。
	ThreadID string `json:"threadId"`
}

// validateNotification 校验一条通知请求。
//
// 两条规则与 Wails 的 validateNotificationOptions 一致，提前在本地拦下是为了
// 给出可读的中文错误，而不是把 "notification ID cannot be empty" 抛到界面上。
//
// Args:
//
//	req: 待校验的请求
//
// Returns:
//
//	ID 或标题为空时返回错误。
func validateNotification(req NotificationRequest) error {
	if strings.TrimSpace(req.ID) == "" {
		return fmt.Errorf("通知 ID 不能为空")
	}
	if strings.TrimSpace(req.Title) == "" {
		return fmt.Errorf("通知标题不能为空")
	}
	return nil
}

// errNotificationUnavailable 表示通知后端还没接上。
var errNotificationUnavailable = errors.New("系统通知不可用：通知服务尚未初始化")

// NotificationService 把系统通知暴露给界面。
//
// 边界：它只回答"能不能发、发出去了没有"，**不做业务判断**——
// 哪些事件值得通知用户由服务端给出的事实决定，Go 侧不在这里重新判一遍。
type NotificationService struct{}

// NewNotificationService 构造通知服务。
func NewNotificationService() *NotificationService {
	return &NotificationService{}
}

// RequestAuthorization 申请系统通知权限。
//
// 在 Windows 上通常直接成功（权限由系统设置决定，不是应用弹窗询问），
// 在 macOS 上会真的弹一次。
//
// Returns:
//
//	是否已授权；通知后端未接上时返回错误。
func (s *NotificationService) RequestAuthorization() (bool, error) {
	backend := currentNotifier()
	if backend == nil {
		return false, errNotificationUnavailable
	}
	return backend.RequestAuthorization()
}

// CheckAuthorization 查询当前是否已获得通知权限。
//
// Returns:
//
//	是否已授权；通知后端未接上时返回错误。
func (s *NotificationService) CheckAuthorization() (bool, error) {
	backend := currentNotifier()
	if backend == nil {
		return false, errNotificationUnavailable
	}
	return backend.CheckAuthorization()
}

// Send 发出一条系统通知。
//
// Args:
//
//	req: 通知内容；ID 与 Title 不能为空
//
// Returns:
//
//	内容不完整、后端未接上或系统拒绝时返回错误。
func (s *NotificationService) Send(req NotificationRequest) error {
	if err := validateNotification(req); err != nil {
		return err
	}

	backend := currentNotifier()
	if backend == nil {
		return errNotificationUnavailable
	}

	return backend.Send(notifications.NotificationOptions{
		ID:       req.ID,
		Title:    req.Title,
		Body:     req.Body,
		ThreadID: req.ThreadID,
	})
}
