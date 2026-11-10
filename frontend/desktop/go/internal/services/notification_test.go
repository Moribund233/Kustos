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
	sent    []notifications.NotificationOptions
	sendErr error
	allowed bool
	authErr error
	asked   bool
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
