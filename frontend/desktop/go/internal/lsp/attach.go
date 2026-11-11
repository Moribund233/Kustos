package lsp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// attachPath 是客户端建立连接的路径。
//
// 参数用查询串而不是路径段：工作区是磁盘上的绝对路径，Windows 上带盘符与
// 反斜杠，塞进路径段要额外处理后仍然很难读日志。
const attachPath = "/lsp/attach"

// readLimit 是单条 WebSocket 消息的上限。
//
// 比 LSP 帧上限小：一条 didChange 带上整篇文件也不会超过这个量，而放宽到
// 帧上限等于允许一个请求在本机进程里占 64MB。
const readLimit = 16 << 20

// writeTimeout 是单条消息的写超时。
//
// 客户端卡住时不该让转发 goroutine 永久挂着——那时进程池以为连接还在，
// 会话不会被回收。
const writeTimeout = 15 * time.Second

// AuthorizeFunc 判断某个工作区是否允许运行语言服务器。
//
// 由装配层提供：它要同时查"是不是我们的工作副本"和"用户有没有信任这个目录"。
// 这两件事都依赖本地库，而进程池本身刻意不碰存储。
type AuthorizeFunc func(root string) error

// Handler 是 `/lsp/` 的 HTTP 处理器：把 WebSocket 与语言服务器的 stdio 接起来。
type Handler struct {
	pool      *Pool
	authorize AuthorizeFunc
}

// NewHandler 构造 LSP 端点处理器。
//
// Args:
//
//	pool:      进程池
//	authorize: 工作区准入判断；返回错误即拒绝
//
// Returns:
//
//	可挂到 bridge 的处理器。
func NewHandler(pool *Pool, authorize AuthorizeFunc) *Handler {
	return &Handler{pool: pool, authorize: authorize}
}

// ServeHTTP 处理一次 WebSocket 连接。
//
// 连接期间把两个方向都转发出去：客户端消息写进服务器 stdin，服务器 stdout
// 的帧回给客户端。连接断开即回收会话（见 Conn.Close）。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	raw := r.URL.Query().Get("root")
	if strings.TrimSpace(raw) == "" {
		writeJSONError(w, http.StatusBadRequest, "缺少 root 参数")
		return
	}
	root, err := filepath.Abs(raw)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "工作区路径无法解析")
		return
	}
	// 准入判断必须在升级之前做完：一旦握手成功，客户端就能往里发任意 LSP
	// 请求，而服务器会照着这些请求去读工作区文件。
	if h.authorize != nil {
		if err := h.authorize(root); err != nil {
			writeJSONError(w, http.StatusForbidden, err.Error())
			return
		}
	}

	conn, err := h.pool.Attach(root)
	if err != nil {
		status := http.StatusConflict
		switch {
		case errors.Is(err, ErrSessionNotFound):
			status = http.StatusNotFound
		case errors.Is(err, ErrRestarting):
			status = http.StatusServiceUnavailable
		}
		writeJSONError(w, status, err.Error())
		return
	}

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// 允许跨端口：桌面端的页面在同一个 host:port 上，但窗口重载后
		// 端口不变、来源不变，这里留空即采用"Origin 必须与 Host 一致"的
		// 默认判定，与 bridge 的同源校验是两道独立防线。
		OriginPatterns: nil,
	})
	if err != nil {
		conn.Close()
		return
	}
	ws.SetReadLimit(readLimit)

	h.pump(r.Context(), ws, conn)
}

// pump 双向转发，直到任一侧关闭。
func (h *Handler) pump(ctx context.Context, ws *websocket.Conn, conn *Conn) {
	defer conn.Close()
	defer func() { _ = ws.CloseNow() }()

	// 客户端 → 服务器。
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			body := trimFrameHeader(data)
			if len(body) == 0 {
				continue
			}
			if err := conn.Send(body); err != nil {
				return
			}
		}
	}()

	// 服务器 → 客户端。
	for {
		select {
		case <-clientDone:
			return
		case body, ok := <-conn.Frames():
			if !ok {
				// 进程退出：给客户端一个明确的关闭码，别让它以为只是网络抖动。
				_ = ws.Close(websocket.StatusGoingAway, "language server exited")
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := ws.Write(writeCtx, websocket.MessageText, body)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

// trimFrameHeader 去掉客户端可能在消息体前加的 `Content-Length` 头。
//
// LSP 的线上格式带帧头，而 WebSocket 本身已经有消息边界。有的客户端仍然按
// 线上格式发送，有的只发裸 JSON；两种都接受，因为"少识别一种"的代价是
// 连接建立后每条消息都解析失败，而那种故障从日志里几乎看不出来。
func trimFrameHeader(data []byte) []byte {
	body := data
	for {
		idx := indexHeaderEnd(body)
		if idx < 0 {
			return body
		}
		head := string(body[:idx])
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(head)), "content-length:") {
			return body
		}
		body = body[idx+headerSepLen:]
	}
}

// headerSepLen 是帧头与消息体之间的分隔串长度（`\r\n\r\n`）。
const headerSepLen = 4

// indexHeaderEnd 找到帧头结束的位置，没有则返回 -1。
func indexHeaderEnd(data []byte) int {
	for i := 0; i+headerSepLen <= len(data); i++ {
		if data[i] == '\r' && data[i+1] == '\n' && data[i+2] == '\r' && data[i+3] == '\n' {
			return i
		}
	}
	return -1
}

// writeJSONError 以 JSON 形式回报拒绝原因。
//
// 用 JSON 而不是纯文本：前端把连接失败显示给用户时要能拿到一句话，而
// http.Error 的纯文本会被 WebSocket 客户端当成握手失败丢掉。
func writeJSONError(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"detail": detail})
}
