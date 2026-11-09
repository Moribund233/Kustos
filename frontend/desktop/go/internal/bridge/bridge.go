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
// 安全约束（缺一不可，见 buildHandler 与 New）：
//   - 只绑 127.0.0.1，端口由系统分配；
//   - 每次启动生成 nonce，作为 HttpOnly + SameSite=Strict cookie 下发；
//   - 首帧没有 cookie，靠 EntryURL 的一次性引导令牌换发，令牌用后即废；
//   - 不返回任何 CORS 头，等于只接受同源；
//   - 只反代白名单前缀与只读公开面 /health，其余 404；
//   - 显式拒绝 /api/app/（实例管理面，桌面端结构上不该有这条路）；
//   - 反代时强制覆写 Origin。
package bridge

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
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
	// entryTokenParam 是入口地址上的一次性引导令牌参数名。
	entryTokenParam = "__bridge"
)

// allowedPrefixes 是唯一允许反代到上游的路径前缀。
//
// `/api/app/` **不在这里**：那是网关按 KUSTOS_ADMIN_ALLOWED_SOURCES 拦掉的
// 实例管理面，桌面端跑在终端用户机器上，出口地址不可控，结构上就过不了那层。
// 让它 404 比打到上游换一个 403 更早、更清楚。
var allowedPrefixes = []string{
	"/api/v1/",
	"/ws",
	"/ws/collab",
	"/lsp/",
}

// publicExactPaths 是前缀白名单之外、按精确匹配放行的只读公开面。
//
// `/health` 是网关与后端的无鉴权探活端点，桌面端允许只读它；用精确匹配而不是
// 前缀，是为了不让 `/healthz`、`/health/live` 这类相邻路径顺带继承放行。
var publicExactPaths = []string{
	"/health",
}

// wailsPrefix 是 Wails 运行时自己的端点前缀。
//
// 前端调用 Go 方法（绑定生成器产出的 `$Call.ByID`）走的是 HTTP
// `POST /wails/runtime`，而不是某种进程内通道。窗口加载的是 bridge 地址，
// 因此这些请求也会先到 bridge：若被当成普通静态资源路径处理，每个按钮
// 都会拿到 `404 page not found`，界面上还完全看不出是传输层的问题。
//
// 这些请求必须交给 Wails 自己的处理器，但仍要过同源校验——它是能执行
// Go 方法的入口，不能因为"不是 /api/ 前缀"就放行。
const wailsPrefix = "/wails/"

// rejectedPrefixes 是显式拒绝的路径：命中即 404，且优先于白名单判断。
var rejectedPrefixes = []string{
	"/api/app/",
}

// Server 是 loopback bridge。
type Server struct {
	listener net.Listener
	nonce    string
	handler  http.Handler

	// upstream 会被 SetUpstream 在运行时替换，反代每次请求读当前值：
	// 切换实例不该重建监听，否则 WebView 的地址与 cookie 都会失效。
	// 用 atomic 而非锁，避免改写阻塞在途请求。
	upstream atomic.Pointer[url.URL]

	// entryMu 保护 entryToken 的换发与作废：作废必须是"比较并清空"的
	// 原子动作，否则并发导航会让同一个令牌成功两次。
	entryMu    sync.Mutex
	entryToken string

	// ipc 是 Wails 运行时端点（`/wails/*`）的处理器，由装配层注入。
	// 用原子指针而非锁：装配后只读，请求路径上不该有锁。
	ipc atomic.Pointer[http.Handler]
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
//	已监听的 bridge；端口由系统分配，调用方通过 BaseURL 取根地址、
//	通过 EntryURL 取 WebView 首次导航的入口地址。
func New(upstream string, extra http.Handler) (*Server, error) {
	base, err := parseUpstream(upstream)
	if err != nil {
		return nil, err
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

	s := &Server{listener: listener, nonce: nonce}
	s.upstream.Store(base)

	entryToken, err := newNonce()
	if err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("生成入口令牌失败: %w", err)
	}
	s.entryToken = entryToken

	s.handler = s.buildHandler(s.newProxy(), extra)
	// 只监听不接 Accept 循环等于不服务：WebView 的首次导航会一直挂在
	// about:blank，窗口等不到 NavigationCompleted 就永远不显示。
	s.serve()
	return s, nil
}

// serve 在监听器上跑 HTTP 服务，直到 Close。
//
// 返回的错误只可能是"监听已关闭"，因此不向外抛：Close 是正常退出路径。
func (s *Server) serve() {
	srv := &http.Server{Handler: s.handler, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(s.listener) }()
}

// newProxy 构造反代。
//
// 上游地址不透传到闭包里，而是每次请求从 Server 读当前值：
// 切换实例时只换地址，不重建监听，WebView 的 origin 与已下发 cookie 都保持有效。
func (s *Server) newProxy() *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			base := s.upstream.Load()
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
}

// buildHandler 组装路由。
func (s *Server) buildHandler(proxy http.Handler, extra http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 1. 首帧引导：WebView 第一次导航时还没有 nonce cookie，
		//    只能凭入口地址上的令牌放行一次，并在这里补发 cookie。
		//    其余请求仍要过下面的同源校验。
		if s.consumeEntryToken(r) {
			http.SetCookie(w, s.NonceCookie())
			serveLocal(w, r, extra)
			return
		}

		// 2. 同源校验：非本 bridge 发起的请求一律 401。
		//    这挡住本机其它进程借用代理访问用户实例。
		if !s.sameOrigin(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		path := r.URL.Path
		// 3. 显式拒绝管理面，先于白名单（否则 /api/v1/ 之类会误放行）。
		for _, p := range rejectedPrefixes {
			if strings.HasPrefix(path, p) {
				http.NotFound(w, r)
				return
			}
		}

		// 4. Wails 运行时端点交给 Wails 自己的处理器。
		//    绑定调用（POST /wails/runtime）必须到得了它，否则界面上每个
		//    按钮都拿到 404，而这看起来像后端接口挂了。
		if strings.HasPrefix(path, wailsPrefix) {
			if ipc := s.ipc.Load(); ipc != nil {
				(*ipc).ServeHTTP(w, r)
				return
			}
			// 没注入处理器时明确 501，而不是伪装成"资源不存在"。
			http.Error(w, "wails ipc handler not attached", http.StatusNotImplemented)
			return
		}

		// 5. 前缀白名单与只读公开面之外，走本地静态资源（桌面端自有产物）。
		if !hasAnyPrefix(path, allowedPrefixes) && !hasAnyExact(path, publicExactPaths) {
			serveLocal(w, r, extra)
			return
		}

		// 6. 白名单前缀反代到上游。不设置任何 CORS 头——没有
		//    Access-Control-Allow-Origin 就等于只接受同源。
		proxy.ServeHTTP(w, r)
	})
}

// SetIPCHandler 注入 Wails 运行时端点（`/wails/*`）的处理器。
//
// Args:
//
//	h: Wails 的资产服务器处理器；传 nil 会断开 IPC
//
// 为什么不放进 New 的参数里：bridge 是传输层，不该在构造时就依赖 Wails
// 的具体实现；装配层在 `application.New` 之后才拿得到那个 handler。
//
// 这些请求仍然要过同源校验：它是能执行 Go 方法的入口，
// 不能因为"不是 /api/ 前缀"就放行。
func (s *Server) SetIPCHandler(h http.Handler) {
	if h == nil {
		s.ipc.Store(nil)
		return
	}
	s.ipc.Store(&h)
}

// consumeEntryToken 判断这次请求是否携带当前的一次性引导令牌。
//
// 只有 `GET /` 接受它：令牌换到的是"同源身份"，不能当绕过同源校验的通行证
// 去访问其它路径。命中即作废，与读取合成一个临界区，否则并发导航会各成功一次。
//
// Args:
//
//	r: 待校验请求
//
// Returns:
//
//	令牌有效且已被本次调用消费时为 true。
func (s *Server) consumeEntryToken(r *http.Request) bool {
	if r.URL.Path != "/" || r.Method != http.MethodGet {
		return false
	}
	// 令牌同样要求回环 Host：DNS 重绑定下浏览器会把恶意域名的 Host 送进来，
	// 一旦这里放行，等于把同源身份交给了任意网页。
	if !isLoopbackHost(r.Host) {
		return false
	}
	got := r.URL.Query().Get(entryTokenParam)
	if got == "" {
		return false
	}

	s.entryMu.Lock()
	defer s.entryMu.Unlock()
	// 常量时间比较：令牌与 nonce 同源风险，不该按字节提前返回。
	if s.entryToken == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.entryToken)) != 1 {
		return false
	}
	s.entryToken = ""
	return true
}

// serveLocal 把请求交给本地静态资源处理器，没有处理器时 404。
func serveLocal(w http.ResponseWriter, r *http.Request, extra http.Handler) {
	if extra != nil {
		extra.ServeHTTP(w, r)
		return
	}
	http.NotFound(w, r)
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
	return isLoopbackHost(r.Host)
}

// isLoopbackHost 判断请求的 Host 是否指向回环。
//
// DNS 重绑定下恶意域名解析到 127.0.0.1 时，浏览器依然会带 cookie，
// 因此凡是"凭凭据放行"的判定都要同时过这一关。
func isLoopbackHost(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return host == "127.0.0.1" || host == "localhost"
}

// BaseURL 返回 bridge 的根地址。
func (s *Server) BaseURL() string {
	return "http://" + s.listener.Addr().String()
}

// EntryURL 返回带一次性引导令牌的入口地址，供 WebView 首次导航使用。
//
// 首帧还没有 nonce cookie，直接打开 BaseURL 会被同源校验挡成 401；入口地址
// 让浏览器先拿到 cookie，此后所有请求（含静态资源与 /api）靠 cookie 通行。
// 令牌只对 `GET /` 有效、且用一次即废，所以每次打开窗口都应重新取一次。
//
// Returns:
//
//	形如 http://127.0.0.1:PORT/?__bridge=<token> 的完整地址。
//	换发不会失败（新令牌来自 crypto/rand；极端失败时沿用旧值并保持可用）。
func (s *Server) EntryURL() string {
	token, err := newNonce()
	if err != nil {
		// 换发失败不该让窗口打不开：保留上一次未消费的令牌继续用。
		s.entryMu.Lock()
		token = s.entryToken
		s.entryMu.Unlock()
	} else {
		s.entryMu.Lock()
		s.entryToken = token
		s.entryMu.Unlock()
	}

	q := url.Values{}
	q.Set(entryTokenParam, token)
	return s.BaseURL() + "/?" + q.Encode()
}

// SetUpstream 在运行时更换反代上游，用于切换实例而不重建监听。
//
// Args:
//
//	raw: 新的上游实例根地址（如 https://kustos.example.com）；首尾空白与末尾斜杠会被忽略
//
// Returns:
//
//	地址非法（无法解析、缺 scheme 或 host）时返回错误，且保持原上游不变。
func (s *Server) SetUpstream(raw string) error {
	base, err := parseUpstream(raw)
	if err != nil {
		return err
	}
	s.upstream.Store(base)
	return nil
}

// parseUpstream 解析并校验上游地址，供 New 与 SetUpstream 共用同一套规则。
//
// Args:
//
//	raw: 上游实例根地址，允许首尾空白与末尾斜杠
//
// Returns:
//
//	解析成功的 *url.URL；缺 scheme 或 host 时返回错误。
func parseUpstream(raw string) (*url.URL, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("上游地址非法: %q", raw)
	}
	return base, nil
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

// Handler 暴露底层 handler，供测试直接驱动（Recorder 模式）。
func (s *Server) Handler() http.Handler { return s.handler }

func hasAnyPrefix(path string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

// hasAnyExact 判断路径是否与给定列表中的某一项完全相同。
//
// 公开面用精确匹配而非前缀：`/health` 之类的端点旁边往往还有 `/healthz`、
// `/health/live` 等未审计的相邻路径，前缀放行会把它们一起带出去。
func hasAnyExact(path string, exact []string) bool {
	for _, p := range exact {
		if path == p {
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
