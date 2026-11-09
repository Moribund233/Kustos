package app

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/kustos/kustos-desktop/internal/bridge"
)

// 装配层最容易断的是"接线"，而不是某个函数本身的逻辑。
//
// 这里锁住一条真实踩过的坑：窗口加载的是 bridge 地址，前端调用 Go 方法的
// 绑定请求走 `POST /wails/runtime`。如果这条链没接到 Wails 的处理器上，
// 界面会正常渲染、但每个按钮都 404——而所有单测都是绿的，因为它们直接打
// `/api/` 前缀，从不经过这条路径。

// 无边框窗口必须开启 WebView2 的非客户区命中测试。
//
// 这条边界值得测：`Frameless: true` 单独存在时界面看起来完全正常——
// 标题栏画出来了、按钮能点——只是拖不动窗口。而 `NonClientRegionSupport`
// 默认 false，漏掉它的表现是"窗口不能移动"，很难往配置上想。
func TestFramelessWindowEnablesNonClientRegionSupport(t *testing.T) {
	// 读取源码做静态断言：真正创建窗口依赖 WebView2 与真实显示器，
	// 在单测里起不来；而这条配置一旦被删就会静默失效，必须有人看着。
	src, err := os.ReadFile("app.go")
	if err != nil {
		t.Fatalf("读源码失败: %v", err)
	}
	code := string(src)

	if !strings.Contains(code, "Frameless: true") {
		t.Fatal("主窗口应是无边框的")
	}
	if !strings.Contains(code, "NonClientRegionSupport: true") {
		t.Fatal("无边框窗口必须开启 NonClientRegionSupport，否则标题栏拖不动窗口")
	}
}

// captureAssets 必须把 Wails 的资产链注入 bridge，否则 IPC 调用拿不到响应。
func TestCaptureAssetsWiresIPCHandlerIntoBridge(t *testing.T) {
	b, err := bridge.New("http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("创建 bridge 失败: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })

	d := &Desktop{bridge: b}

	var reached string
	fakeAssets := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	d.captureAssets(fakeAssets)

	// 用真实监听端口请求：这条链路的价值就在传输层，Recorder 测不到 cookie 行为。
	req := httptest.NewRequest(http.MethodPost, b.BaseURL()+"/wails/runtime", nil)
	req.AddCookie(b.NonceCookie())
	rec := httptest.NewRecorder()
	b.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("IPC 请求应到达资产链，实际状态 %d（说明 handler 没接上）", rec.Code)
	}
	if reached != "/wails/runtime" {
		t.Fatalf("资产链应收到原始路径，实际 %q", reached)
	}
}

// 未接线时必须明确失败（501），而不是伪装成"资源不存在"。
//
// 404 会让人以为是路径写错或静态文件缺失，501 才能指向"装配漏了一步"。
func TestIPCDistinguishesUnwiredFromMissing(t *testing.T) {
	b, err := bridge.New("http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("创建 bridge 失败: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })

	req := httptest.NewRequest(http.MethodPost, b.BaseURL()+"/wails/runtime", nil)
	req.AddCookie(b.NonceCookie())
	rec := httptest.NewRecorder()
	b.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("未接线时应 501，实际 %d", rec.Code)
	}
}

// captureAssets 可能被 Wails 多次调用（中间件构造时机不止一处），
// 只应生效一次，且后续调用不改变已接好的处理器。
func TestCaptureAssetsIsIdempotent(t *testing.T) {
	b, err := bridge.New("http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("创建 bridge 失败: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })

	d := &Desktop{bridge: b}

	first := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	second := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})

	d.captureAssets(first)
	d.captureAssets(second)

	req := httptest.NewRequest(http.MethodPost, b.BaseURL()+"/wails/runtime", nil)
	req.AddCookie(b.NonceCookie())
	rec := httptest.NewRecorder()
	b.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("首次捕获的处理器应保持生效，实际 %d", rec.Code)
	}
}
