package bridge

import (
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// Wails 的绑定调用（$Call.ByID）走自己的 IPC 端点，不是 fetch("/api/...")。
//
// 窗口加载的是 bridge 地址，因此这些请求也会先到 bridge。若 bridge 把它们当
// 普通路径交给静态资源处理器，所有 Go 方法调用都会 404——表现为"界面能显示，
// 但点任何按钮都报 404 page not found"，而且不会出现在任何日志里。
func TestWailsIPCPathsReachIPCService(t *testing.T) {
	var gotPaths []string
	ipc := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	s := newTestServerWithIPC(t, "http://127.0.0.1:1", nil, ipc)

	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/wails/runtime", strings.NewReader(`{}`))
	req.AddCookie(s.NonceCookie())
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code == http.StatusUnauthorized {
		t.Fatal("带 nonce 的 IPC 调用不应被同源校验拦住")
	}
	if len(gotPaths) != 1 || gotPaths[0] != "/wails/runtime" {
		t.Fatalf("IPC 处理器应收到原始路径，实际 %v", gotPaths)
	}
}

// IPC 端点同样要过同源校验：它是能调用 Go 方法的入口，
// 不能因为"不是 API 前缀"就放行。
func TestWailsIPCRequiresSameOrigin(t *testing.T) {
	ipc := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	s := newTestServerWithIPC(t, "http://127.0.0.1:1", nil, ipc)

	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/_wails/runtime", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("缺 nonce 的 IPC 调用应 401，实际 %d", rec.Code)
	}
}

// 这些测试把 bridge 的安全约束写成可执行的断言，
// 而不是只存在于注释里。

func TestSameOriginRejectsMissingNonce(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/v1/repos", nil)
	rec := httptest.NewRecorder()

	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("缺少 nonce 应 401，实际 %d", rec.Code)
	}
}

func TestSameOriginRejectsWrongNonce(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/v1/repos", nil)
	req.AddCookie(&http.Cookie{Name: nonceCookieName, Value: "wrong"})
	rec := httptest.NewRecorder()

	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("nonce 不匹配应 401，实际 %d", rec.Code)
	}
}

// DNS 重绑定：攻击者让恶意域名解析到 127.0.0.1 时，浏览器仍会带 cookie，
// 因此必须同时校验 Host。
func TestSameOriginRejectsNonLoopbackHost(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "http://evil.example/api/v1/repos", nil)
	req.Host = "evil.example"
	req.AddCookie(s.NonceCookie())
	rec := httptest.NewRecorder()

	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("非回环 Host 应 401，实际 %d", rec.Code)
	}
}

// 管理面必须 404：桌面端过不了网关的来源白名单，这条路结构上就不该存在。
func TestAdminAPIRejected(t *testing.T) {
	s := newTestServer(t)
	for _, path := range []string{"/api/app/config", "/api/app/status", "/api/app/shutdown"} {
		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+path, nil)
		req.AddCookie(s.NonceCookie())
		rec := httptest.NewRecorder()

		s.Handler().ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Errorf("%s 应 404，实际 %d", path, rec.Code)
		}
	}
}

// 白名单前缀放行到上游。
func TestAllowedPrefixProxied(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Origin 必须被覆写，否则上游可能把桌面端误判成 CSRF。
		if got := r.Header.Get("Origin"); !strings.HasPrefix(got, "http://") {
			t.Errorf("Origin 未被覆写: %q", got)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	s := newTestServerWithUpstream(t, upstream.URL)
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/v1/repos", nil)
	req.AddCookie(s.NonceCookie())
	rec := httptest.NewRecorder()

	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("白名单前缀应放行，实际 %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("应返回上游响应，实际 %q", rec.Body.String())
	}
}

// 不返回任何 CORS 头：等于只接受同源。
func TestNoCORSHeaders(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodOptions, "http://127.0.0.1/api/v1/repos", nil)
	req.Header.Set("Origin", "http://evil.example")
	req.AddCookie(s.NonceCookie())
	rec := httptest.NewRecorder()

	s.Handler().ServeHTTP(rec, req)

	if v := rec.Header().Get("Access-Control-Allow-Origin"); v != "" {
		t.Fatalf("不应返回 CORS 头，实际 %q", v)
	}
}

// nonce cookie 的 HttpOnly + SameSite 是安全前提，不能被改掉。
func TestNonceCookieAttributes(t *testing.T) {
	s := newTestServer(t)
	c := s.NonceCookie()

	if !c.HttpOnly {
		t.Error("nonce cookie 必须 HttpOnly")
	}
	if c.SameSite != http.SameSiteStrictMode {
		t.Error("nonce cookie 必须 SameSite=Strict")
	}
	if len(c.Value) < 32 {
		t.Errorf("nonce 过短: %d", len(c.Value))
	}
}

func TestBaseURLIsLoopback(t *testing.T) {
	s := newTestServer(t)
	if !strings.HasPrefix(s.BaseURL(), "http://127.0.0.1:") {
		t.Fatalf("bridge 必须只绑回环，实际 %s", s.BaseURL())
	}
}

// 白名单里的 /health 必须精确匹配：/healthz 之类的相似路径不能顺带放行。
func TestHealthAllowedButSimilarPathNot(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer upstream.Close()

	s := newTestServerWithUpstream(t, upstream.URL)

	if rec := serveWithNonce(s, "/health"); rec.Code != http.StatusOK {
		t.Fatalf("/health 应放行到上游，实际 %d", rec.Code)
	} else if !strings.Contains(rec.Body.String(), `"status":"ok"`) {
		t.Fatalf("/health 应返回上游响应，实际 %q", rec.Body.String())
	}

	for _, path := range []string{"/healthz", "/health/", "/health/live"} {
		if rec := serveWithNonce(s, path); rec.Code != http.StatusNotFound {
			t.Errorf("%s 不应被放行，实际 %d", path, rec.Code)
		}
	}
}

// 上游地址要能在运行时换（切换实例不该重建 bridge，否则窗口地址会变）。
func TestSetUpstreamSwitchesUpstream(t *testing.T) {
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"upstream":"first"}`))
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"upstream":"second"}`))
	}))
	defer second.Close()

	s := newTestServerWithUpstream(t, first.URL)
	if rec := serveWithNonce(s, "/health"); !strings.Contains(rec.Body.String(), `"first"`) {
		t.Fatalf("初始上游应为 first，实际 %q", rec.Body.String())
	}

	if err := s.SetUpstream(second.URL); err != nil {
		t.Fatalf("换上游失败: %v", err)
	}
	if rec := serveWithNonce(s, "/health"); !strings.Contains(rec.Body.String(), `"second"`) {
		t.Fatalf("换上游后应打到 second，实际 %q", rec.Body.String())
	}
}

// 非法上游必须被拒绝，且不能把原来可用的上游弄坏。
func TestSetUpstreamRejectsInvalidURL(t *testing.T) {
	s := newTestServerWithUpstream(t, "http://127.0.0.1:1")

	for _, raw := range []string{"", "kustos.example.com", "://bad"} {
		if err := s.SetUpstream(raw); err == nil {
			t.Errorf("%q 应被拒绝", raw)
		}
	}

	if rec := serveWithNonce(s, "/health"); rec.Code != http.StatusBadGateway {
		t.Fatalf("被拒的上游不应生效，实际 %d", rec.Code)
	}
}

// 真实监听 + 真实 http.Client 的入口链路：
// 首帧没有 nonce cookie，只能靠 EntryURL 的一次性令牌换 cookie，再凭 cookie 反代。
func TestEntryURLBootstrapsNonce(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer upstream.Close()

	s := newListeningServer(t, upstream.URL, spaHandler("桥接入口"))
	client := newEntryClient(t)

	resp := mustGet(t, client, mustEntryURL(t, s))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("入口 URL 应返回 SPA，实际 %d", resp.StatusCode)
	}
	if body := readBody(t, resp); !strings.Contains(body, "桥接入口") {
		t.Fatalf("入口 URL 应返回 SPA，实际 %q", body)
	}

	// 下发的 cookie 必须带住安全属性，否则同源校验形同虚设。
	var boot *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == nonceCookieName {
			boot = c
		}
	}
	if boot == nil {
		t.Fatal("入口响应必须下发 nonce cookie")
	}
	if !boot.HttpOnly || boot.SameSite != http.SameSiteStrictMode {
		t.Fatalf("nonce cookie 属性不对: HttpOnly=%v SameSite=%v", boot.HttpOnly, boot.SameSite)
	}

	// 真实客户端带 cookie 走反代，打到 httptest 上游。
	health := mustGet(t, client, s.BaseURL()+"/health")
	if health.StatusCode != http.StatusOK {
		t.Fatalf("/health 应 200，实际 %d", health.StatusCode)
	}
	if body := readBody(t, health); !strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("/health 应返回上游响应，实际 %q", body)
	}
}

// 入口令牌一次性：换一个没有 cookie 的客户端再访问同一个 URL 必须 401。
func TestEntryTokenSingleUse(t *testing.T) {
	s := newListeningServer(t, "http://127.0.0.1:1", spaHandler("桥接入口"))
	entry := mustEntryURL(t, s)

	client := newEntryClient(t)
	if resp := mustGet(t, client, entry); resp.StatusCode != http.StatusOK {
		t.Fatalf("首次使用入口令牌应 200，实际 %d", resp.StatusCode)
	}

	// 拿到 cookie 之后，普通导航（不带令牌）必须继续可用——否则刷新即白屏。
	if resp := mustGet(t, client, s.BaseURL()+"/"); resp.StatusCode != http.StatusOK {
		t.Fatalf("已持有 cookie 的普通导航应 200，实际 %d", resp.StatusCode)
	}

	if resp := mustGet(t, newEntryClient(t), entry); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("入口令牌重复使用应 401，实际 %d", resp.StatusCode)
	}
}

// 每个窗口/每次重载都要能重新引导，所以消费后 EntryURL 必须能换发新令牌。
func TestEntryURLReissuesAfterConsume(t *testing.T) {
	s := newListeningServer(t, "http://127.0.0.1:1", spaHandler("桥接入口"))

	if resp := mustGet(t, newEntryClient(t), mustEntryURL(t, s)); resp.StatusCode != http.StatusOK {
		t.Fatalf("首次引导应 200，实际 %d", resp.StatusCode)
	}
	if resp := mustGet(t, newEntryClient(t), mustEntryURL(t, s)); resp.StatusCode != http.StatusOK {
		t.Fatalf("重新引导应 200，实际 %d", resp.StatusCode)
	}
}

// 令牌只在根路径上被接受：不能拿它当绕过同源校验的通行证打到别处。
func TestEntryTokenOnlyAcceptedOnRoot(t *testing.T) {
	s := newListeningServer(t, "http://127.0.0.1:1", spaHandler("桥接入口"))

	entry, err := url.Parse(mustEntryURL(t, s))
	if err != nil {
		t.Fatalf("入口 URL 无法解析: %v", err)
	}
	token := entry.Query().Get("__bridge")

	// 非根路径即使带上令牌也必须 401，顺带确认根路径之外的路径没有被顺带放行。
	req := httptest.NewRequest(http.MethodGet, s.BaseURL()+"/api/v1/repos?"+entryTokenParam+"="+token, nil)
	req.Host = "127.0.0.1"
	rec := httptest.NewRecorder()

	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("根路径之外的令牌不应放行，实际 %d", rec.Code)
	}

	// 非 GET 的根请求同样不消费令牌：导航是 GET，别的动词没有引导语义。
	req = httptest.NewRequest(http.MethodPost, s.BaseURL()+"/?"+entryTokenParam+"="+token, nil)
	req.Host = "127.0.0.1"
	rec = httptest.NewRecorder()

	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("非 GET 的入口令牌不应放行，实际 %d", rec.Code)
	}
}

// 入口令牌不能替代同源校验里的 Host 检查：DNS 重绑定下恶意域名照样能拼出
// 带令牌的 URL，若只看令牌就等于把同源身份交给了任意网页。
func TestEntryTokenRejectsNonLoopbackHost(t *testing.T) {
	s := newListeningServer(t, "http://127.0.0.1:1", spaHandler("桥接入口"))

	entry, err := url.Parse(mustEntryURL(t, s))
	if err != nil {
		t.Fatalf("入口 URL 无法解析: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet,
		s.BaseURL()+"/?"+entryTokenParam+"="+entry.Query().Get(entryTokenParam), nil)
	req.Host = "evil.example"
	rec := httptest.NewRecorder()

	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("非回环 Host 的入口令牌不应放行，实际 %d", rec.Code)
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("被拒的入口请求不应下发 nonce cookie")
	}
}

// 令牌的作废必须是一次性的原子操作：并发抢同一个入口 URL 只能有一个成功。
func TestEntryTokenConsumedOnlyOnce(t *testing.T) {
	s := newListeningServer(t, "http://127.0.0.1:1", spaHandler("桥接入口"))
	entry := mustEntryURL(t, s)

	const clients = 8
	codes := make(chan int, clients)
	var wg sync.WaitGroup
	for i := 0; i < clients; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// 不带 cookie 的客户端：只能靠令牌换 cookie，正好测令牌的竞态。
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Get(entry)
			if err != nil {
				codes <- 0
				return
			}
			defer func() { _ = resp.Body.Close() }()
			_, _ = io.Copy(io.Discard, resp.Body)
			codes <- resp.StatusCode
		}()
	}
	wg.Wait()
	close(codes)

	ok := 0
	for code := range codes {
		switch code {
		case http.StatusOK:
			ok++
		case http.StatusUnauthorized:
		default:
			t.Errorf("意外状态码 %d", code)
		}
	}
	if ok != 1 {
		t.Fatalf("一次性令牌应恰好成功一次，实际 %d", ok)
	}
}

// 多窗口：每个窗口各自持有一个入口地址，任何一个先导航都不能让另一个失效。
//
// 这条边界值得单独测：单令牌实现下两个窗口的代码各自看起来都对，症状却
// 落在"后开的窗口一切正常、先开的那个白屏"——排查时会去怀疑窗口生命周期，
// 而真正的错在令牌的发放策略。
func TestEntryURLsCoexistAcrossWindows(t *testing.T) {
	s := newListeningServer(t, "http://127.0.0.1:1", spaHandler("桥接入口"))

	first := mustEntryURL(t, s)
	second := mustEntryURL(t, s)
	if first == second {
		t.Fatal("两个窗口应各自拿到不同的入口令牌")
	}

	// 顺序反过来也要成立：后发的令牌不该顶掉先发的。
	for i, entry := range []string{first, second} {
		if resp := mustGet(t, newEntryClient(t), entry); resp.StatusCode != http.StatusOK {
			t.Fatalf("第 %d 个窗口的入口地址应 200，实际 %d", i+1, resp.StatusCode)
		}
	}

	// 两个都已消费过，第三次必须 401——并存不等于可以重复使用。
	if resp := mustGet(t, newEntryClient(t), first); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("已消费的入口地址应 401，实际 %d", resp.StatusCode)
	}
}

func newTestServer(t *testing.T) *Server {
	t.Helper()
	s, err := New("http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("创建 bridge 失败: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// newTestServerWithIPC 起一个注入了 IPC 处理器的 bridge。
func newTestServerWithIPC(t *testing.T, upstream string, extra, ipc http.Handler) *Server {
	t.Helper()
	s, err := New(upstream, extra)
	if err != nil {
		t.Fatalf("创建 bridge 失败: %v", err)
	}
	s.SetIPCHandler(ipc)
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func newTestServerWithUpstream(t *testing.T, upstream string) *Server {
	t.Helper()
	s, err := New(upstream, nil)
	if err != nil {
		t.Fatalf("创建 bridge 失败: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// serveWithNonce 用 Recorder 打一次已带 nonce cookie 的请求。
func serveWithNonce(s *Server, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+path, nil)
	req.AddCookie(s.NonceCookie())
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

// mustEntryURL 取一个入口地址，失败即终止测试。
//
// 入口地址是导航的唯一来源，取不到时后续断言全无意义，直接在原地失败
// 比让测试带着空串往下跑更好定位。
func mustEntryURL(t *testing.T, s *Server) string {
	t.Helper()
	entry, err := s.EntryURL()
	if err != nil {
		t.Fatalf("取入口地址失败: %v", err)
	}
	return entry
}

// newListeningServer 起一个真正在回环端口上服务的 bridge。
//
// New 既监听也开始服务，因此客户端不必等：拿到 BaseURL 就能发请求。
// e2e 必须走真实连接——Recorder 只测得到 handler，测不到 cookie 在传输层的
// 实际行为。
func newListeningServer(t *testing.T, upstream string, extra http.Handler) *Server {
	t.Helper()
	s, err := New(upstream, extra)
	if err != nil {
		t.Fatalf("创建 bridge 失败: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// New 之后就该能应答：漏掉 Accept 循环时连接会堵在内核队列里，
// WebView 最终停在 about:blank、窗口永不显示。
func TestNewServesRequests(t *testing.T) {
	s := newListeningServer(t, "https://upstream.example", nil)

	resp, err := newEntryClient(t).Get(mustEntryURL(t, s))
	if err != nil {
		t.Fatalf("New 之后应立即响应请求: %v", err)
	}
	_ = resp.Body.Close()

	// 入口令牌换到的是同源身份，必须有 cookie 下发。
	if len(resp.Cookies()) == 0 {
		t.Fatal("入口响应应下发 nonce cookie")
	}
}

// newEntryClient 返回带独立 cookie 罐的客户端。
//
// 每个客户端代表"另一个浏览器/另一个窗口"：cookie 不共享，
// 因此只能用自己引导得到的 nonce 访问后续路径。
func newEntryClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("创建 cookie 罐失败: %v", err)
	}
	return &http.Client{Timeout: 5 * time.Second, Jar: jar}
}

func mustGet(t *testing.T, client *http.Client, target string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("请求 %s 失败: %v", target, err)
	}
	return resp
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()
	buf, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取响应失败: %v", err)
	}
	return string(buf)
}

// spaHandler 冒充桌面端自己的静态资源分支。
func spaHandler(marker string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<html><body>" + marker + "</body></html>"))
	})
}
