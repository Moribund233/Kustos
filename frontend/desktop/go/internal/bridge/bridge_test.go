package bridge

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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

func newTestServer(t *testing.T) *Server {
	t.Helper()
	s, err := New("http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("创建 bridge 失败: %v", err)
	}
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
