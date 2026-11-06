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
