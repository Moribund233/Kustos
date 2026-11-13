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
	// RegisterCategory 注册一组动作按钮。
	RegisterCategory(category notifications.NotificationCategory) error
	// SendWithActions 发出一条带动作按钮的通知。
	SendWithActions(options notifications.NotificationOptions) error
	// OnResponse 订阅用户对通知的响应（点击正文或动作按钮）。
	OnResponse(callback func(result notifications.NotificationResult))
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

func (w wailsNotifier) RegisterCategory(category notifications.NotificationCategory) error {
	return w.svc.RegisterNotificationCategory(category)
}

func (w wailsNotifier) SendWithActions(options notifications.NotificationOptions) error {
	return w.svc.SendNotificationWithActions(options)
}

func (w wailsNotifier) OnResponse(callback func(result notifications.NotificationResult)) {
	w.svc.OnNotificationResponse(callback)
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

// NotificationAction 是通知上的一个动作按钮。
//
// 按钮本身只回传一个标识，**动作真正做什么由界面决定**：Go 侧不解析
// "批准"这件事，它只把"用户点了哪个按钮、来自哪条通知"原样交回前端。
// 这样审批权限、目标是否仍然有效仍由服务端判定，桌面端不多出一条旁路。
type NotificationAction struct {
	// ID 是动作标识，回调里原样带回。
	ID string `json:"id"`
	// Title 是按钮文案。
	Title string `json:"title"`
}

// ActionableNotification 是一条带动作按钮的通知。
type ActionableNotification struct {
	// CategoryID 是动作组的标识：同一组按钮注册一次即可复用。
	CategoryID string `json:"categoryId"`
	// Actions 是按钮清单，至少一个、至多三个（Windows 通知最多放三个，
	// 多了系统会自己截断，而截断哪几个是不可预期的）。
	Actions []NotificationAction `json:"actions"`
	// Request 是通知本体。
	Request NotificationRequest `json:"request"`
	// Data 随通知一起下发，用户点击后原样回到 `NotificationActivated` 事件里。
	// 界面用它判断"这是哪个 PR 的批准按钮"。
	Data map[string]string `json:"data"`
}

// maxNotificationActions 是 Windows 通知能容纳的按钮上限。
const maxNotificationActions = 3

// validateActionable 校验一条带动作的通知。
//
// Args:
//
//	req: 待校验的请求
//
// Returns:
//
//	分类、按钮或通知本体不合法时返回错误。
func validateActionable(req ActionableNotification) error {
	if err := validateNotification(req.Request); err != nil {
		return err
	}
	if strings.TrimSpace(req.CategoryID) == "" {
		return fmt.Errorf("通知动作组 ID 不能为空")
	}
	if len(req.Actions) == 0 {
		return fmt.Errorf("通知动作不能为空")
	}
	if len(req.Actions) > maxNotificationActions {
		// 不静默截断：用户会以为四个按钮都在，而系统只显示了三个。
		return fmt.Errorf("通知动作最多 %d 个，实际 %d 个", maxNotificationActions, len(req.Actions))
	}
	seen := make(map[string]bool, len(req.Actions))
	for _, action := range req.Actions {
		if strings.TrimSpace(action.ID) == "" {
			return fmt.Errorf("通知动作 ID 不能为空")
		}
		if strings.TrimSpace(action.Title) == "" {
			return fmt.Errorf("通知动作标题不能为空")
		}
		if seen[action.ID] {
			// 重复 ID 会让点击结果二义：到底哪个按钮被按下了。
			return fmt.Errorf("通知动作 ID 重复: %q", action.ID)
		}
		seen[action.ID] = true
	}
	return nil
}

// NotificationActivated 是用户对通知做出的响应，会广播给界面。
//
// 界面据此执行真正的动作（批准、打开某个 PR），Go 侧不替他判断权限。
type NotificationActivated struct {
	// NotificationID 是原始通知的 ID。
	NotificationID string `json:"notificationId"`
	// ActionID 是被点击的按钮标识；点击通知正文时为空（系统回默认动作）。
	ActionID string `json:"actionId"`
	// CategoryID 是动作组标识。
	CategoryID string `json:"categoryId"`
	// Title、Body 回传原文，便于界面在没有本地记录时也能显示来源。
	Title string `json:"title"`
	Body  string `json:"body"`
	// Data 是发送时随通知带上的附加数据。
	Data map[string]string `json:"data"`
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

// 通知响应回调与广播出去的通道。
//
// 用包级变量而不是服务字段：用户点通知时执行的是"把结果送出进程"这一件事，
// 天然只有一份；而且回调要在 app.Run() 之前注册，那时服务对象可能还没被
// 装配到界面上。
var (
	activatedMu     sync.RWMutex
	activatedEmit   func(NotificationActivated)
)

// BindNotificationActivated 接上"用户响应了通知"的广播实现。
//
// Args:
//
//	emit: 收到响应时调用；由装配层转成 Wails 事件发往界面
func BindNotificationActivated(emit func(NotificationActivated)) {
	activatedMu.Lock()
	defer activatedMu.Unlock()
	activatedEmit = emit
}

// currentActivatedEmitter 返回已接上的广播实现；未接线时为 nil。
func currentActivatedEmitter() func(NotificationActivated) {
	activatedMu.RLock()
	defer activatedMu.RUnlock()
	return activatedEmit
}

// SendActionable 发出一条带动作按钮的通知。
//
// Args:
//
//	req: 通知内容与按钮；按钮最多三个、ID 不能重复
//
// Returns:
//
//	内容不合法、后端未接上或系统拒绝时返回错误。
//
// 动作组会先注册：Windows 上按钮定义挂在分类下，先发通知再注册分类的话，
// 第一次点击可能落在一个系统不认识的按钮上。
func (s *NotificationService) SendActionable(req ActionableNotification) error {
	if err := validateActionable(req); err != nil {
		return err
	}

	backend := currentNotifier()
	if backend == nil {
		return errNotificationUnavailable
	}

	actions := make([]notifications.NotificationAction, 0, len(req.Actions))
	for _, action := range req.Actions {
		actions = append(actions, notifications.NotificationAction{ID: action.ID, Title: action.Title})
	}
	if err := backend.RegisterCategory(notifications.NotificationCategory{
		ID:      req.CategoryID,
		Actions: actions,
	}); err != nil {
		return fmt.Errorf("注册通知动作组失败: %w", err)
	}

	// Data 要转成 map[string]interface{}：Wails 的字段类型是后者，
	// 而界面传上来的值是字符串。签名对不上时点击回调会把数据丢空。
	data := make(map[string]interface{}, len(req.Data))
	for key, value := range req.Data {
		data[key] = value
	}

	return backend.SendWithActions(notifications.NotificationOptions{
		ID:         req.Request.ID,
		Title:      req.Request.Title,
		Body:       req.Request.Body,
		ThreadID:   req.Request.ThreadID,
		CategoryID: req.CategoryID,
		Data:       data,
	})
}

// ListenNotificationResponses 接上"用户点了通知"的回调。
//
// 由装配层在通知后端接好之后调用一次。拆成导出函数而不是放进
// NotificationService 的方法：绑定生成器会把服务的每个导出方法变成前端可调用的
// RPC，而"订阅系统回调"属于装配动作，不该出现在界面能调用的接口里。
func ListenNotificationResponses() {
	listenResponses()
}

// listenResponses 把系统通知的点击转成一条进程内广播。
//
// 只在后端接上之后调用一次。它不判断"这个按钮点了该做什么"——那由界面
// 与服务端决定；这里只负责把事实交出去。
func listenResponses() {
	backend := currentNotifier()
	if backend == nil {
		return
	}
	backend.OnResponse(func(result notifications.NotificationResult) {
		emit := currentActivatedEmitter()
		if emit == nil {
			return
		}
		// 系统回报的默认动作标识不是用户真按了某个按钮，归一成空串，
		// 让界面能区分"点了正文"与"点了某个按钮"。
		actionID := result.Response.ActionIdentifier
		if actionID == notifications.DefaultActionIdentifier {
			actionID = ""
		}
		data := make(map[string]string, len(result.Response.UserInfo))
		for key, value := range result.Response.UserInfo {
			if text, ok := value.(string); ok {
				data[key] = text
			}
		}
		emit(NotificationActivated{
			NotificationID: result.Response.ID,
			ActionID:       actionID,
			CategoryID:     result.Response.CategoryID,
			Title:          result.Response.Title,
			Body:           result.Response.Body,
			Data:           data,
		})
	})
}
