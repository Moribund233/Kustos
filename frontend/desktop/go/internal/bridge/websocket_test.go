package bridge

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 协作编辑（M5）走的是 `ws://<bridge>/ws/collab`，因此 bridge 必须能把
// WebSocket 升级原样反代到上游。这条链路失败时前端只看到"连不上协作"，
// 与"网关没开协作"完全无法区分，所以要在传输层就固定住。
//
// 测试手工走一遍握手：真实 TCP 连到 bridge 的监听地址，发 HTTP/1.1 升级请求，
// 期望拿到 101，然后双向能收发字节。用 Recorder 测不了——升级会把连接抢走，
// 而 Recorder 没有底层连接。
func TestProxyUpgradesWebSocket(t *testing.T) {
	upstream, hits := newUpgradeUpstream(t)
	s := newTestServerWithUpstream(t, upstream)

	conn := dialBridge(t, s)
	defer func() { _ = conn.Close() }()

	status, rest := handshake(t, conn, s, "/ws/collab?name=repo:main:a.ts")
	if !strings.HasPrefix(status, "HTTP/1.1 101") {
		t.Fatalf("协作 WebSocket 应拿到 101，实际 %q", status)
	}
	if got := <-hits; got != "/ws/collab" {
		t.Fatalf("上游应收到 /ws/collab，实际 %q", got)
	}

	// 升级之后是裸字节流：写一行，上游原样回一行。
	if _, err := fmt.Fprint(conn, "ping\n"); err != nil {
		t.Fatalf("写升级后的数据失败: %v", err)
	}
	line, err := rest.ReadString('\n')
	if err != nil {
		t.Fatalf("读升级后的数据失败: %v", err)
	}
	if line != "ping\n" {
		t.Fatalf("升级后的数据应原样回传，实际 %q", line)
	}
}

// 白名单之外的路径不能被当成 WebSocket 反代出去。
//
// 这条断言防的是"白名单失效但没人发现"：若 bridge 把所有 Upgrade 请求都转给
// 上游，本机任意进程都能借它连到用户实例的任意内部端点。
func TestProxyRejectsWebSocketOutsideWhitelist(t *testing.T) {
	upstream, hits := newUpgradeUpstream(t)
	s := newTestServerWithUpstream(t, upstream)

	conn := dialBridge(t, s)
	defer func() { _ = conn.Close() }()

	status, _ := handshake(t, conn, s, "/collab/secret")
	if strings.Contains(status, " 101") {
		t.Fatalf("白名单外的路径不应升级成功，实际 %q", status)
	}
	select {
	case got := <-hits:
		t.Fatalf("白名单外的路径不应打到上游，实际收到 %q", got)
	case <-time.After(200 * time.Millisecond):
	}
}

// newUpgradeUpstream 起一个只做 WebSocket 握手与回声的上游。
//
// 不引第三方 WebSocket 库：这里要验证的只是"升级请求与 101 响应能不能穿过
// 反代"，自己写 101 响应比接一个库更能暴露 bridge 一侧的问题。
//
// Returns:
//
//	上游地址；以及一个只保留路径的 chan，用于断言请求确实到达了上游。
func newUpgradeUpstream(t *testing.T) (string, chan string) {
	t.Helper()

	hits := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits <- r.URL.Path

		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "expected websocket upgrade", http.StatusBadRequest)
			return
		}

		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Errorf("上游抢占连接失败: %v", err)
			return
		}
		defer func() { _ = conn.Close() }()

		accept := base64.StdEncoding.EncodeToString([]byte(r.Header.Get("Sec-WebSocket-Key")))
		_, _ = fmt.Fprintf(conn,
			"HTTP/1.1 101 Switching Protocols\r\n"+
				"Upgrade: websocket\r\n"+
				"Connection: Upgrade\r\n"+
				"Sec-WebSocket-Accept: %s\r\n\r\n", accept)
		if err := rw.Flush(); err != nil {
			return
		}

		// 回声一行就够：证明连接在被 bridge 抢走之后仍然是双向可读写的。
		line, err := rw.ReadString('\n')
		if err != nil {
			return
		}
		_, _ = conn.Write([]byte(line))
	}))
	t.Cleanup(srv.Close)
	return srv.URL, hits
}

// dialBridge 与 bridge 的监听地址建立真实 TCP 连接。
func dialBridge(t *testing.T, s *Server) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", s.listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatalf("连接 bridge 失败: %v", err)
	}
	return conn
}

// handshake 发一次 WebSocket 升级请求，返回状态行与尚未读完的连接读者。
//
// 带 nonce cookie：升级请求同样要过同源校验，否则本机其它进程能借 bridge
// 连上游协作网关。
func handshake(t *testing.T, conn net.Conn, s *Server, path string) (string, *bufio.Reader) {
	t.Helper()

	host := s.listener.Addr().String()
	_, _ = fmt.Fprintf(conn,
		"GET %s HTTP/1.1\r\n"+
			"Host: %s\r\n"+
			"Origin: http://%s\r\n"+
			"Connection: Upgrade\r\n"+
			"Upgrade: websocket\r\n"+
			"Sec-WebSocket-Version: 13\r\n"+
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"+
			"Cookie: %s=%s\r\n\r\n",
		path, host, host, nonceCookieName, s.nonce)

	reader := bufio.NewReader(conn)
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("设置读超时失败: %v", err)
	}
	status, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("读响应状态行失败: %v", err)
	}
	// 跳过响应头，剩下的就是升级后的数据流。
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("读响应头失败: %v", err)
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	// 之后的读不该再受握手超时限制。
	_ = conn.SetReadDeadline(time.Time{})
	return strings.TrimRight(status, "\r\n"), reader
}
