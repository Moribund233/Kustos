package lsp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// newTestEndpoint 起一个只跑 LSP 处理器的 HTTP 服务，返回服务地址与池。
//
// 单独起服务而不是复用 bridge：这一层要验的是"WebSocket ↔ stdio 转发"和准入
// 判断，bridge 的同源校验另有它的测试，混在一起会让失败原因难判断。
func newTestEndpoint(t *testing.T, mode string, authorize AuthorizeFunc) (string, *Pool) {
	t.Helper()
	pool := newFakePool(t, mode, Options{})
	handler := NewHandler(pool, authorize)
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	t.Cleanup(pool.Close)
	return srv.URL, pool
}

// wsURL 把 http 地址换成 ws，并带上 root 参数。
func wsURL(base, root string) string {
	url := strings.Replace(base, "http://", "ws://", 1) + attachPath
	if root != "" {
		url += "?root=" + root
	}
	return url
}

// dialExpectStatus 发起握手并要求失败，返回 HTTP 状态与响应体。
func dialExpectStatus(t *testing.T, url string, want int) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, url, nil)
	if err == nil {
		_ = conn.CloseNow()
		t.Fatalf("握手本应失败，实际成功")
	}
	if resp == nil {
		t.Fatalf("握手失败但没有响应: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != want {
		t.Fatalf("状态码应为 %d，实际 %d", want, resp.StatusCode)
	}
	var payload struct {
		Detail string `json:"detail"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&payload)
	return payload.Detail
}

func TestAttachRequiresRoot(t *testing.T) {
	base, _ := newTestEndpoint(t, "echo", nil)
	if detail := dialExpectStatus(t, wsURL(base, ""), http.StatusBadRequest); detail == "" {
		t.Error("拒绝时应给出原因")
	}
}

func TestAttachRejectsForbiddenWorkspace(t *testing.T) {
	deny := errors.New("这个工作区还没有被信任")
	base, _ := newTestEndpoint(t, "echo", func(string) error { return deny })

	detail := dialExpectStatus(t, wsURL(base, t.TempDir()), http.StatusForbidden)
	if !strings.Contains(detail, "信任") {
		t.Errorf("应当带上拒绝原因，实际 %q", detail)
	}
}

// 准入判断必须能拿到"实际要连的那个目录"，否则它无从判断。
func TestAttachPassesRootToAuthorizer(t *testing.T) {
	root := tempWorkspace(t)
	seen := make(chan string, 1)
	base, pool := newTestEndpoint(t, "echo", func(got string) error {
		seen <- got
		return nil
	})
	if _, err := pool.Ensure(root, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL(base, root), nil)
	if err != nil {
		t.Fatalf("握手失败: %v", err)
	}
	defer conn.CloseNow()

	select {
	case got := <-seen:
		if got != root {
			t.Errorf("准入判断应收到 %s，实际 %s", root, got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("准入判断没有被调用")
	}
}

func TestAttachWithoutSessionReturnsNotFound(t *testing.T) {
	base, _ := newTestEndpoint(t, "echo", nil)
	dialExpectStatus(t, wsURL(base, tempWorkspace(t)), http.StatusNotFound)
}

func TestAttachBridgesFrames(t *testing.T) {
	root := tempWorkspace(t)
	base, pool := newTestEndpoint(t, "echo", nil)
	if _, err := pool.Ensure(root, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL(base, root), nil)
	if err != nil {
		t.Fatalf("握手失败: %v", err)
	}
	defer conn.CloseNow()

	payload := `{"jsonrpc":"2.0","id":1,"method":"initialize"}`
	if err := conn.Write(ctx, websocket.MessageText, []byte(payload)); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if string(data) != payload {
		t.Errorf("转发内容不一致:\n want %s\n got  %s", payload, data)
	}
}

// 有的客户端按 LSP 线上格式发送（带 Content-Length 头），转发层要认出来。
func TestAttachStripsClientFrameHeader(t *testing.T) {
	root := tempWorkspace(t)
	base, pool := newTestEndpoint(t, "echo", nil)
	if _, err := pool.Ensure(root, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL(base, root), nil)
	if err != nil {
		t.Fatalf("握手失败: %v", err)
	}
	defer conn.CloseNow()

	payload := `{"jsonrpc":"2.0","id":2,"method":"initialized"}`
	framed := "Content-Length: " + itoa(len(payload)) + "\r\n\r\n" + payload
	if err := conn.Write(ctx, websocket.MessageText, []byte(framed)); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if string(data) != payload {
		t.Errorf("帧头应被剥掉:\n want %s\n got  %s", payload, data)
	}
}

func TestAttachRejectsSecondConnection(t *testing.T) {
	root := tempWorkspace(t)
	base, pool := newTestEndpoint(t, "echo", nil)
	if _, err := pool.Ensure(root, "go"); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first, _, err := websocket.Dial(ctx, wsURL(base, root), nil)
	if err != nil {
		t.Fatalf("第一次握手失败: %v", err)
	}
	defer first.CloseNow()

	dialExpectStatus(t, wsURL(base, root), http.StatusConflict)
}

func TestTrimFrameHeader(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{name: "裸 JSON", in: `{"id":1}`, want: `{"id":1}`},
		{name: "带帧头", in: "Content-Length: 8\r\n\r\n{\"id\":1}", want: `{"id":1}`},
		{name: "小写帧头", in: "content-length: 8\r\n\r\n{\"id\":1}", want: `{"id":1}`},
		{name: "多帧头", in: "Content-Length: 8\r\nContent-Type: application/json\r\n\r\n{\"id\":1}", want: `{"id":1}`},
		{name: "空消息", in: "", want: ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := string(trimFrameHeader([]byte(c.in))); got != c.want {
				t.Errorf("want %q, got %q", c.want, got)
			}
		})
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf []byte
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	return string(buf)
}
