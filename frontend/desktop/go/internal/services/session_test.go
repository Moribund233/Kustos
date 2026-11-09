package services

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Probe 是桌面端启动时唯一的网络调用，失败路径比成功路径更常见
// （自托管实例常在内网/VPN 后面），因此两边都要锁住。

func TestProbeUnreachable(t *testing.T) {
	s := newProbeOnly()
	info := s.Probe("http://127.0.0.1:1")

	if info.Reachable {
		t.Fatal("不可达实例不应标记为可达")
	}
	if info.Error == "" {
		t.Fatal("失败时必须给出原因，前端据此显示「连不上」")
	}
}

func TestProbeEmptyURL(t *testing.T) {
	s := newProbeOnly()
	if info := s.Probe("   "); info.Reachable || info.Error == "" {
		t.Fatalf("空地址应直接失败，实际 %+v", info)
	}
}

func TestProbeReadsVersionAndCompat(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/":
			_, _ = w.Write([]byte(`{"title":"Kustos","version":"0.1.0"}`))
		case "/api/v1/client-compat":
			_, _ = w.Write([]byte(`{
				"api_version":"v1","api_min":"v1","server_version":"0.1.0",
				"features":{"collab_active":true,"idempotency_key":true}
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	info := newProbeOnly().Probe(srv.URL)

	if !info.Reachable {
		t.Fatalf("应可达，实际错误: %s", info.Error)
	}
	if info.Version != "0.1.0" {
		t.Errorf("版本 = %q", info.Version)
	}
	if info.APICompat == nil {
		t.Fatal("应解析出兼容性声明")
	}
	if info.APICompat.APIMin != "v1" {
		t.Errorf("api_min = %q", info.APICompat.APIMin)
	}
	if !info.APICompat.Features["collab_active"] {
		t.Error("features.collab_active 应为 true")
	}
}

// 老实例没有 client-compat 端点：此时必须仍然可用（降级到只看 version），
// 而不是把整个探活判为失败。
func TestProbeToleratesMissingCompatEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			_, _ = w.Write([]byte(`{"title":"老实例","version":"0.0.9"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	info := newProbeOnly().Probe(srv.URL)

	if !info.Reachable {
		t.Fatalf("缺 client-compat 不应导致探活失败: %s", info.Error)
	}
	if info.APICompat != nil {
		t.Fatal("缺端点时 APICompat 应为 nil，让前端回退到版本判断")
	}
	if info.Version != "0.0.9" {
		t.Errorf("版本 = %q", info.Version)
	}
}

// 真实部署里 `GET /` 返回的是前端 SPA 的 HTML，不是 JSON。
//
// 网关把根路径让给了前端路由，后端那个返回 JSON 的 `@router.get("/")`
// 被 SPA 兜底覆盖。探活若坚持在根路径上解析 JSON，所有真实实例都会
// 被判成"连不上"——而兼容性声明端点本来就是免鉴权的公开面，正是
// 为这个场景加的。
func TestProbeWorksWhenRootServesHTML(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(`<!doctype html><html><body><div id="root"></div></body></html>`))
		case "/api/v1/client-compat":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"api_version":"v1","api_min":"v1","server_version":"0.1.0",
				"features":{"collab_active":true}
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	info := newProbeOnly().Probe(srv.URL)

	if !info.Reachable {
		t.Fatalf("根路径是 HTML 时仍应判为可达，实际错误: %s", info.Error)
	}
	if info.APICompat == nil {
		t.Fatal("应从兼容性声明取到能力")
	}
	if info.Version == "" {
		t.Error("版本应来自兼容性声明，不能为空")
	}
}

// 根路径 404（纯 API 部署、无前端）时，兼容性声明仍然可以判定可达。
func TestProbeWorksWhenRootIs404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/client-compat" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"api_version":"v1","api_min":"v1","server_version":"2.3.4"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	info := newProbeOnly().Probe(srv.URL)

	if !info.Reachable {
		t.Fatalf("根路径 404 但有 client-compat 时应可达: %s", info.Error)
	}
	if info.Version != "2.3.4" {
		t.Errorf("版本 = %q", info.Version)
	}
}

// 根路径也 404、兼容性声明也没有：那才是真的连不上。
func TestProbeFailsWhenNothingResponds(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.NotFound(w, nil)
	}))
	defer srv.Close()

	if info := newProbeOnly().Probe(srv.URL); info.Reachable {
		t.Fatal("根路径与兼容性声明都 404 时不应判为可达")
	}
}

// 5xx 是失败，不是"可达但版本空"。
func TestProbeServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	if info := newProbeOnly().Probe(srv.URL); info.Reachable {
		t.Fatal("5xx 不应视为可达")
	}
}

// 尾部斜杠与多余空格不该影响拼接（否则会请求到 //api/v1/...）。
func TestProbeTrimsBaseURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"title":"t","version":"1"}`))
	}))
	defer srv.Close()

	info := newProbeOnly().Probe("  " + srv.URL + "/  ")
	if !info.Reachable {
		t.Fatalf("应容忍首尾空白与斜杠: %s", info.Error)
	}
}

// newProbeOnly 构造只用于探活测试的会话服务。
// 探活本身不依赖 store 与 keychain，因此这里不需要装配它们。
func newProbeOnly() *SessionService {
	return &SessionService{client: &http.Client{Timeout: instanceProbeTimeout}}
}
