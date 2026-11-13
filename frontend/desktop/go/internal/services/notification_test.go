package services

import (
	"errors"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// fakeNotifier 是通知后端的替身。
//
// 真实后端要 GUI 与系统通知中心，在单测里起不来；而这一层真正值得测的是
// "校验拦住没有、参数有没有传对"，那些不需要真的弹一条通知。
type fakeNotifier struct {
	sent      []notifications.NotificationOptions
	withActs  []notifications.NotificationOptions
	cats      []notifications.NotificationCategory
	sendErr   error
	catErr    error
	allowed   bool
	authErr   error
	asked     bool
	responses func(notifications.NotificationResult)
}

func (f *fakeNotifier) Send(options notifications.NotificationOptions) error {
	if f.sendErr != nil {
		return f.sendErr
	}
	f.sent = append(f.sent, options)
	return nil
}

func (f *fakeNotifier) RequestAuthorization() (bool, error) {
	f.asked = true
	return f.allowed, f.authErr
}

func (f *fakeNotifier) CheckAuthorization() (bool, error) {
	return f.allowed, f.authErr
}

func (f *fakeNotifier) RegisterCategory(category notifications.NotificationCategory) error {
	if f.catErr != nil {
		return f.catErr
	}
	f.cats = append(f.cats, category)
	return nil
}

func (f *fakeNotifier) SendWithActions(options notifications.NotificationOptions) error {
	if f.sendErr != nil {
		return f.sendErr
	}
	f.withActs = append(f.withActs, options)
	return nil
}

func (f *fakeNotifier) OnResponse(callback func(result notifications.NotificationResult)) {
	f.responses = callback
}

// withFakeNotifier 装上替身后端并在结束时还原。
func withFakeNotifier(t *testing.T) *fakeNotifier {
	t.Helper()
	fake := &fakeNotifier{allowed: true}

	notifyMu.Lock()
	original := notifyImpl
	notifyImpl = fake
	notifyMu.Unlock()

	t.Cleanup(func() {
		notifyMu.Lock()
		notifyImpl = original
		notifyMu.Unlock()
	})
	return fake
}

func TestValidateNotificationRejectsEmptyID(t *testing.T) {
	err := validateNotification(NotificationRequest{Title: "有新评审请求"})
	if err == nil {
		t.Fatal("空 ID 应被拒绝")
	}
	if !strings.Contains(err.Error(), "ID") {
		t.Fatalf("错误信息应指出是 ID 的问题，实际 %q", err.Error())
	}
}

func TestValidateNotificationRejectsEmptyTitle(t *testing.T) {
	err := validateNotification(NotificationRequest{ID: "pr-42"})
	if err == nil {
		t.Fatal("空标题应被拒绝")
	}
	if !strings.Contains(err.Error(), "标题") {
		t.Fatalf("错误信息应指出是标题的问题，实际 %q", err.Error())
	}
}

func TestValidateNotificationRejectsWhitespaceOnly(t *testing.T) {
	// 只填空格与什么都没填对用户是一回事，不该放过去变成一条空白通知。
	if err := validateNotification(NotificationRequest{ID: "   ", Title: "标题"}); err == nil {
		t.Fatal("纯空白的 ID 应被拒绝")
	}
	if err := validateNotification(NotificationRequest{ID: "id", Title: "  \t "}); err == nil {
		t.Fatal("纯空白的标题应被拒绝")
	}
}

func TestValidateNotificationAcceptsComplete(t *testing.T) {
	if err := validateNotification(NotificationRequest{ID: "pr-42", Title: "有新评审请求"}); err != nil {
		t.Fatalf("完整请求应通过校验，实际 %v", err)
	}
}

func TestSendPassesFieldsThrough(t *testing.T) {
	fake := withFakeNotifier(t)
	svc := NewNotificationService()

	err := svc.Send(NotificationRequest{
		ID:       "pr-42",
		Title:    "有新评审请求",
		Body:     "octo 请你评审 #42",
		ThreadID: "pr-42",
	})
	if err != nil {
		t.Fatalf("发送失败: %v", err)
	}

	if len(fake.sent) != 1 {
		t.Fatalf("应发出恰好一条通知，实际 %d", len(fake.sent))
	}
	got := fake.sent[0]
	if got.ID != "pr-42" || got.Title != "有新评审请求" || got.Body != "octo 请你评审 #42" {
		t.Fatalf("通知字段没有原样传递: %+v", got)
	}
	if got.ThreadID != "pr-42" {
		t.Fatalf("ThreadID 应透传（它决定通知是否堆叠），实际 %q", got.ThreadID)
	}
}

func TestSendValidatesBeforeTouchingBackend(t *testing.T) {
	fake := withFakeNotifier(t)
	svc := NewNotificationService()

	if err := svc.Send(NotificationRequest{Title: "缺 ID"}); err == nil {
		t.Fatal("缺 ID 应报错")
	}
	// 校验不通过的请求不该到达系统通知中心：那会在用户桌面上留下一条残缺通知。
	if len(fake.sent) != 0 {
		t.Fatalf("校验失败时不应调用后端，实际发了 %d 条", len(fake.sent))
	}
}

func TestSendPropagatesBackendError(t *testing.T) {
	fake := withFakeNotifier(t)
	fake.sendErr = errors.New("系统拒绝")
	svc := NewNotificationService()

	err := svc.Send(NotificationRequest{ID: "x", Title: "y"})
	if err == nil {
		t.Fatal("后端失败应向上传递，否则界面会以为通知发出去了")
	}
}

func TestNotificationUnavailableWhenUnwired(t *testing.T) {
	notifyMu.Lock()
	original := notifyImpl
	notifyImpl = nil
	notifyMu.Unlock()
	t.Cleanup(func() {
		notifyMu.Lock()
		notifyImpl = original
		notifyMu.Unlock()
	})

	svc := NewNotificationService()

	// 明确报"不可用"，而不是静默成功：一个以为发出去了其实没发的通知，
	// 比一条说清原因的错误难查得多。
	if err := svc.Send(NotificationRequest{ID: "x", Title: "y"}); err == nil {
		t.Fatal("未接线时发送应报错")
	}
	if _, err := svc.RequestAuthorization(); err == nil {
		t.Fatal("未接线时申请授权应报错")
	}
	if _, err := svc.CheckAuthorization(); err == nil {
		t.Fatal("未接线时查询授权应报错")
	}
}

func TestAuthorizationDelegates(t *testing.T) {
	fake := withFakeNotifier(t)
	fake.allowed = false
	svc := NewNotificationService()

	ok, err := svc.CheckAuthorization()
	if err != nil {
		t.Fatalf("查询授权失败: %v", err)
	}
	if ok {
		t.Fatal("替身返回未授权时应如实反映")
	}

	fake.allowed = true
	ok, err = svc.RequestAuthorization()
	if err != nil {
		t.Fatalf("申请授权失败: %v", err)
	}
	if !ok {
		t.Fatal("授权成功后应返回 true")
	}
	if !fake.asked {
		t.Fatal("申请授权应真的走到后端")
	}
}

// ==================== 带动作的通知 ====================

func TestValidateActionableRequiresCategoryAndActions(t *testing.T) {
	base := ActionableNotification{
		CategoryID: "pr-review",
		Actions:    []NotificationAction{{ID: "approve", Title: "批准"}},
		Request:    NotificationRequest{ID: "pr-42", Title: "待你评审"},
	}
	if err := validateActionable(base); err != nil {
		t.Fatalf("完整请求应通过: %v", err)
	}

	noCategory := base
	noCategory.CategoryID = " "
	if err := validateActionable(noCategory); err == nil {
		t.Fatal("缺动作组应被拒绝")
	}

	noActions := base
	noActions.Actions = nil
	if err := validateActionable(noActions); err == nil {
		t.Fatal("没有按钮应被拒绝")
	}
}

func TestValidateActionableRejectsTooManyActions(t *testing.T) {
	// 系统最多显示三个，多出来的会被静默截断；那比报错更糟——
	// 用户以为四个按钮都在。
	err := validateActionable(ActionableNotification{
		CategoryID: "pr-review",
		Actions: []NotificationAction{
			{ID: "a", Title: "A"},
			{ID: "b", Title: "B"},
			{ID: "c", Title: "C"},
			{ID: "d", Title: "D"},
		},
		Request: NotificationRequest{ID: "pr-42", Title: "待你评审"},
	})
	if err == nil {
		t.Fatal("超过三个按钮应被拒绝")
	}
	if !strings.Contains(err.Error(), "3") {
		t.Fatalf("错误信息应说明上限，实际 %q", err.Error())
	}
}

func TestValidateActionableRejectsDuplicateIDs(t *testing.T) {
	err := validateActionable(ActionableNotification{
		CategoryID: "pr-review",
		Actions: []NotificationAction{
			{ID: "approve", Title: "批准"},
			{ID: "approve", Title: "同意"},
		},
		Request: NotificationRequest{ID: "pr-42", Title: "待你评审"},
	})
	if err == nil {
		t.Fatal("重复动作 ID 应被拒绝")
	}
}

func TestValidateActionableRejectsBlankActionFields(t *testing.T) {
	for _, tc := range []struct {
		name   string
		action NotificationAction
	}{
		{"空 ID", NotificationAction{Title: "批准"}},
		{"空标题", NotificationAction{ID: "approve"}},
		{"只有空格", NotificationAction{ID: "  ", Title: "  "}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateActionable(ActionableNotification{
				CategoryID: "pr-review",
				Actions:    []NotificationAction{tc.action},
				Request:    NotificationRequest{ID: "pr-42", Title: "待你评审"},
			})
			if err == nil {
				t.Fatalf("%s 应被拒绝", tc.name)
			}
		})
	}
}

func TestSendActionableRegistersCategoryFirst(t *testing.T) {
	fake := withFakeNotifier(t)
	svc := NewNotificationService()

	err := svc.SendActionable(ActionableNotification{
		CategoryID: "pr-review",
		Actions:    []NotificationAction{{ID: "approve", Title: "批准"}},
		Request:    NotificationRequest{ID: "pr-42", Title: "待你评审", Body: "改了三处"},
		Data:       map[string]string{"repo": "01abc", "number": "42"},
	})
	if err != nil {
		t.Fatalf("发送失败: %v", err)
	}
	if len(fake.cats) != 1 || fake.cats[0].ID != "pr-review" {
		t.Fatalf("应先注册动作组，实际 %+v", fake.cats)
	}
	if len(fake.withActs) != 1 {
		t.Fatalf("应发出一条带动作的通知，实际 %d 条", len(fake.withActs))
	}
	sent := fake.withActs[0]
	if sent.CategoryID != "pr-review" {
		t.Fatalf("通知上要带动作组，实际 %q", sent.CategoryID)
	}
	if sent.Data["repo"] != "01abc" || sent.Data["number"] != "42" {
		t.Fatalf("附加数据应随通知下发，实际 %+v", sent.Data)
	}
	// 普通 Send 不该被这一次调用碰到。
	if len(fake.sent) != 0 {
		t.Fatalf("带动作的通知不该走普通发送路径，实际 %d 条", len(fake.sent))
	}
}

func TestSendActionableFailsWhenCategoryRegistrationFails(t *testing.T) {
	fake := withFakeNotifier(t)
	fake.catErr = errors.New("注册失败")
	svc := NewNotificationService()

	err := svc.SendActionable(ActionableNotification{
		CategoryID: "pr-review",
		Actions:    []NotificationAction{{ID: "approve", Title: "批准"}},
		Request:    NotificationRequest{ID: "pr-42", Title: "待你评审"},
	})
	if err == nil {
		t.Fatal("动作组注册失败时不该声称发送成功")
	}
	if len(fake.withActs) != 0 {
		t.Fatal("动作组没注册上就不该发通知：按钮会点了没反应")
	}
}

func TestNotificationResponseIsForwarded(t *testing.T) {
	fake := withFakeNotifier(t)

	var got []NotificationActivated
	activatedMu.Lock()
	original := activatedEmit
	activatedEmit = func(ev NotificationActivated) { got = append(got, ev) }
	activatedMu.Unlock()
	t.Cleanup(func() {
		activatedMu.Lock()
		activatedEmit = original
		activatedMu.Unlock()
	})

	ListenNotificationResponses()
	if fake.responses == nil {
		t.Fatal("应订阅系统回调")
	}

	fake.responses(notifications.NotificationResult{
		Response: notifications.NotificationResponse{
			ID:               "pr-42",
			ActionIdentifier: "approve",
			CategoryID:       "pr-review",
			Title:            "待你评审",
			Body:             "改了三处",
			UserInfo:         map[string]interface{}{"repo": "01abc"},
		},
	})

	if len(got) != 1 {
		t.Fatalf("应转发一条响应，实际 %d 条", len(got))
	}
	if got[0].ActionID != "approve" || got[0].NotificationID != "pr-42" {
		t.Fatalf("响应内容应原样带出，实际 %+v", got[0])
	}
	if got[0].Data["repo"] != "01abc" {
		t.Fatalf("附加数据应带回，实际 %+v", got[0].Data)
	}
}

func TestDefaultActionIsNormalizedToEmpty(t *testing.T) {
	// 点通知正文时系统回的是默认动作标识。归一成空串，界面才能区分
	// "他点了正文"与"他按下了批准"——后者是一个有后果的动作。
	fake := withFakeNotifier(t)

	var got []NotificationActivated
	activatedMu.Lock()
	original := activatedEmit
	activatedEmit = func(ev NotificationActivated) { got = append(got, ev) }
	activatedMu.Unlock()
	t.Cleanup(func() {
		activatedMu.Lock()
		activatedEmit = original
		activatedMu.Unlock()
	})

	ListenNotificationResponses()
	fake.responses(notifications.NotificationResult{
		Response: notifications.NotificationResponse{
			ID:               "pr-42",
			ActionIdentifier: notifications.DefaultActionIdentifier,
		},
	})

	if len(got) != 1 {
		t.Fatalf("应转发一条响应，实际 %d 条", len(got))
	}
	if got[0].ActionID != "" {
		t.Fatalf("默认动作应归一成空串，实际 %q", got[0].ActionID)
	}
}
