// Package bridge 实现 loopback bridge：一个只绑定 127.0.0.1 的本机反向代理。
//
// 为什么需要它：WebView 加载自有产物后，向
// https://kustos.example.com/api/v1/... 发请求属于跨源，需要服务端为
// wails:// 放行 CORS——对一个自托管产品意味着每次部署都要改配置，不可接受。
//
// 采用 bridge 的真正收益是三件事，不是"代理"本身：
//
//  1. 前端与 Web 同构：`fetch("/api/v1/...")` 原样可用，共享层不需要传输分支；
//  2. refresh token 只在 Go 与内存里，永不进 JS；
//  3. CI 能不开窗口测：go test 起 bridge，Playwright 指过去跑真实链路。
//
// 安全约束（缺一不可，见 ServeHTTP 与 New）：
//   - 只绑 127.0.0.1，端口由系统分配；
//   - 每次启动生成 nonce，作为 HttpOnly + SameSite=Strict cookie 下发；
//   - 不返回任何 CORS 头，等于只接受同源；
//   - 只反代白名单前缀，其余 404；
//   - 显式拒绝 /api/app/（实例管理面，桌面端结构上不该有这条路）；
//   - 反代时强制覆写 Origin。
package bridge

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

const (
	// nonceCookieName 是首帧下发的同源校验 cookie。
	nonceCookieName = "kustos_bridge"
	// nonceHeaderName 是 JS 侧读取后回传的头（HttpOnly 使 JS 读不到 cookie
	// 原文，因此由 Go 在首个 HTML 响应里注入页面脚本）。
	nonceHeaderName = "X-Kustos-Bridge"
	// nonceBytes 是 nonce 长度（32 字节）。
	nonceBytes = 32
)

// allowedPrefixes 是唯一允许反代到上游的路径前缀。
//
// `/api/app/` **不在这里**：那是网关按 KUSTOS_ADMIN_ALLOWED_SOURCES 拦掉的
// 实例管理面，桌面端跑在终端用户机器上，出口地址不可控，结构上就过不了那层
// 桌面端跑在终端用户机器上，出口地址不可控，结构上过不了那层。
// 让它 404 比打到上游换一个 403 更早、更清楚。
var allowedPrefixes = []string{
	"/api/v1/",
	"/ws",
	"/ws/collab",
	"/lsp/",
}

// rejectedPrefixes 是显式拒绝的路径：命中即 404，且优先于白名单判断。
var rejectedPrefixes = []string{
	"/api/app/",
}

// Server 是 loopback bridge。
type Server struct {
	listener net.Listener
	nonce    string
	handler  http.Handler
}

// New 创建并开始监听 bridge。
//
// Args:
//
//	upstream: 上游实例根地址（如 https://kustos.example.com）
//	extra: 附加的本地路径处理器（如桌面端自己的静态资源），可为 nil
//
// Returns:
//
//	已监听的 bridge；端口由系统分配，调用方通过 BaseURL 取得。
func New(upstream string, extra http.Handler) (*Server, error) {
	base, err := url.Parse(strings.TrimRight(upstream, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("上游地址非法: %q", upstream)
	}

	nonce, err := newNonce()
	if err != nil {
		return nil, fmt.Errorf("生成 nonce 失败: %w", err)
	}

	// 只绑回环：不监听 0.0.0.0，进程退出即关闭。
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("监听回环端口失败: %w", err)
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(base)
			// 强制覆写 Origin：上游若按 Origin 做 CSRF 判定，桌面端的
			// http://127.0.0.1:<port> 会被误判成跨站来源。
			r.Out.Header.Set("Origin", base.Scheme+"://"+base.Host)
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			// 上游不可达时给结构化错误，前端据此显示"离线"而不是白屏。
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = fmt.Fprintf(w, `{"detail":%q}`, "实例不可达: "+err.Error())
		},
	}

	s := &Server{listener: listener, nonce: nonce}
	s.handler = s.buildHandler(proxy, extra)
	return s, nil
}

// buildHandler 组装路由。
func (s *Server) buildHandler(proxy http.Handler, extra http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 1. 同源校验：非本 bridge 发起的请求一律 401。
		//    这挡住本机其它进程借用代理访问用户实例。
		if !s.sameOrigin(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		path := r.URL.Path
		// 2. 显式拒绝管理面，先于白名单（否则 /api/v1/ 之类会误放行）。
		for _, p := range rejectedPrefixes {
			if strings.HasPrefix(path, p) {
				http.NotFound(w, r)
				return
			}
		}

		// 3. 非 API 前缀走本地静态资源（桌面端自有产物）。
		if !hasAnyPrefix(path, allowedPrefixes) {
			if extra != nil {
				extra.ServeHTTP(w, r)
				return
			}
			http.NotFound(w, r)
			return
		}

		// 4. 白名单前缀反代到上游。不设置任何 CORS 头——没有
		//    Access-Control-Allow-Origin 就等于只接受同源。
		proxy.ServeHTTP(w, r)
	})
}

// sameOrigin 校验请求来自本 bridge。
//
// 两重确认：nonce cookie 必须存在且匹配；Host 必须是回环地址（防 DNS 重绑定
// ——攻击者让 evil.example 解析到 127.0.0.1 后，浏览器仍会带上我们的 cookie）。
func (s *Server) sameOrigin(r *http.Request) bool {
	cookie, err := r.Cookie(nonceCookieName)
	if err != nil || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(s.nonce)) != 1 {
		return false
	}

	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return host == "127.0.0.1" || host == "localhost"
}

// BaseURL 返回 bridge 的根地址。
func (s *Server) BaseURL() string {
	return "http://" + s.listener.Addr().String()
}

// NonceCookie 返回首帧要下发的 Set-Cookie 指令。
//
// HttpOnly：JS 读不到，降低 XSS 后借代理访问用户实例的可能；
// SameSite=Strict：跨站请求根本不带这个 cookie。
func (s *Server) NonceCookie() *http.Cookie {
	return &http.Cookie{
		Name:     nonceCookieName,
		Value:    s.nonce,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		// 回环 http 下不能设 Secure，否则 cookie 会被浏览器丢弃。
		Secure: false,
	}
}

// Close 停止监听。
func (s *Server) Close() error {
	if s.listener == nil {
		return nil
	}
	return s.listener.Close()
}

// Handler 暴露底层 handler，供测试与 Wails 资产服务器复用。
func (s *Server) Handler() http.Handler { return s.handler }

// Serve 在给定 listener 上提供服务（测试用；正常路径由 New + BaseURL 承担）。
func (s *Server) Serve() error {
	if s.listener == nil {
		return errors.New("bridge 未监听")
	}
	srv := &http.Server{Handler: s.handler, ReadHeaderTimeout: 10 * time.Second}
	return srv.Serve(s.listener)
}

func hasAnyPrefix(path string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

func newNonce() (string, error) {
	buf := make([]byte, nonceBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
