package lsp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/kustos/kustos-desktop/internal/platform/noconsole"
)

// 默认参数。数字都来自设计文档 §7.3，改动前先看那里的理由。
const (
	// DefaultMaxSessions 是同时存活的服务器上限。
	//
	// gopls 单实例常吃 1GB 以上，三个已经是普通开发机的上限；不设限时
	// "打开五个仓库"会让整机换页，用户感受到的是整个应用变卡，而不是
	// "语言服务器太多"。
	DefaultMaxSessions = 3

	// DefaultIdleTimeout 是没有客户端连接时进程的保留时长。
	//
	// 只在"进程起来了但客户端还没连上"时有意义：崩溃重启后等待重连、
	// 以及 Ensure 预热之后的窗口期。超时即回收，避免崩溃的服务器变成
	// 永远不退的孤儿进程。
	DefaultIdleTimeout = 10 * time.Minute

	// readBufferSize 是 stdout 的缓冲，够装几帧即可。
	readBufferSize = 64 << 10

	// stderrTail 是保留的 stderr 尾部字节数。
	stderrTail = 4 << 10

	// frameQueue 是每会话的消息队列深度。
	frameQueue = 64
)

// 会话状态。
const (
	// StateStarting 表示进程正在拉起。
	StateStarting = "starting"
	// StateRunning 表示进程存活。
	StateRunning = "running"
	// StateRestarting 表示进程已崩，正在退避重启。
	StateRestarting = "restarting"
	// StateFailed 表示重启次数用尽，需要用户手动介入。
	StateFailed = "failed"
)

var (
	// ErrTooManySessions 表示已达到并发上限。
	ErrTooManySessions = errors.New("同时运行的本地语言服务器已达上限，先关掉其他仓库的编辑器")
	// ErrServerMissing 表示该语言的服务器没装。
	ErrServerMissing = errors.New("未安装本地语言服务器")
	// ErrSessionNotFound 表示没有该工作区对应的会话。
	ErrSessionNotFound = errors.New("没有该工作区的语言服务器会话")
	// ErrAlreadyAttached 表示同一工作区已有客户端连着。
	ErrAlreadyAttached = errors.New("该工作区的语言服务器已被另一个编辑器连接")
	// ErrRestarting 表示进程正在重启，还没有可用的消息通道。
	ErrRestarting = errors.New("语言服务器正在重启，请稍后重试")
)

// 默认退避序列：1s / 2s / 4s，三次之后放弃。
var defaultRestartDelays = []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}

// Options 是进程池参数。零值即默认值。
type Options struct {
	// MaxSessions 是并发上限。
	MaxSessions int
	// IdleTimeout 是无客户端时进程的保留时长。
	IdleTimeout time.Duration
	// RestartDelays 是崩溃后的重试间隔；长度即最大重试次数。
	RestartDelays []time.Duration
	// Command 用于替换进程构造（测试注入假服务器）。
	Command func(ctx context.Context, name string, args ...string) *exec.Cmd
	// Resolve 用于替换"在 PATH 里找服务器"这一步（测试注入假服务器）。
	//
	// 单独抽出来是因为测试需要一条确定存在的可执行文件，而真实探测必然依赖
	// 用户机器上装了什么——把两者绑死会让这层逻辑只能在装了 gopls 的机器上测。
	Resolve func(Language) (string, bool)
}

// Info 是一个会话对外的快照。
//
// 扁平结构：它会被绑定生成器原样变成 TS 类型，嵌套内部状态会让前端的
// 类型随实现漂移。
type Info struct {
	// Root 是工作区根目录。
	Root string `json:"root"`
	// Language 是语言 ID。
	Language string `json:"language"`
	// Server 是实际使用的可执行文件路径。
	Server string `json:"server"`
	// State 是会话状态。
	State string `json:"state"`
	// Attached 表示当前是否有客户端连着。
	Attached bool `json:"attached"`
	// Restarts 是已发生的崩溃重启次数。
	Restarts int `json:"restarts"`
	// LastError 是最近一次失败的原因（stderr 尾部或启动错误）。
	LastError string `json:"lastError"`
	// StartedAt 是进程启动时间（Unix 毫秒）。
	StartedAt int64 `json:"startedAt"`
}

// Pool 管理本地语言服务器进程。
//
// 一个工作区最多一个进程：LSP 的 rootUri 语义就是单根，共享进程会让
// "跳转到定义"落到别的仓库里。
type Pool struct {
	mu       sync.Mutex
	sessions map[string]*session
	closed   bool

	maxSessions   int
	idleTimeout   time.Duration
	restartDelays []time.Duration
	command       func(ctx context.Context, name string, args ...string) *exec.Cmd
	resolve       func(Language) (string, bool)
}

// NewPool 创建进程池。
//
// Args:
//
//	opts: 参数；零值字段取默认值
//
// Returns:
//
//	可用的进程池；调用方负责 Close。
func NewPool(opts Options) *Pool {
	p := &Pool{
		sessions:      make(map[string]*session),
		maxSessions:   opts.MaxSessions,
		idleTimeout:   opts.IdleTimeout,
		restartDelays: opts.RestartDelays,
		command:       opts.Command,
		resolve:       opts.Resolve,
	}
	if p.maxSessions <= 0 {
		p.maxSessions = DefaultMaxSessions
	}
	if p.idleTimeout <= 0 {
		p.idleTimeout = DefaultIdleTimeout
	}
	if len(p.restartDelays) == 0 {
		p.restartDelays = defaultRestartDelays
	}
	if p.command == nil {
		p.command = exec.CommandContext
	}
	if p.resolve == nil {
		p.resolve = func(l Language) (string, bool) { return l.Resolve() }
	}
	return p
}

// Ensure 保证该工作区有一个存活的服务器进程。
//
// 幂等：已经有会话时直接返回其快照，不会重复拉起。
//
// Args:
//
//	root: 工作区根的绝对路径
//	languageID: 语言 ID（见 Languages）；空串表示按 marker 自动探测
//
// Returns:
//
//	会话快照；服务器未安装时返回包装了 ErrServerMissing 的错误（调用方据此
//	给出安装命令并降级为仅高亮），已达并发上限时返回 ErrTooManySessions。
func (p *Pool) Ensure(root, languageID string) (Info, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return Info{}, fmt.Errorf("解析工作区路径失败: %w", err)
	}
	if st, err := os.Stat(abs); err != nil || !st.IsDir() {
		return Info{}, fmt.Errorf("工作区不存在或不是目录: %s", abs)
	}

	lang, ok := Lookup(languageID)
	if languageID == "" {
		lang, ok = Detect(abs)
		if !ok {
			return Info{}, errors.New("没有识别出该工作区的语言（缺少 marker 文件）")
		}
	} else if !ok {
		return Info{}, fmt.Errorf("未知语言: %s", languageID)
	}

	serverPath, ok := p.resolve(lang)
	if !ok {
		return Info{}, fmt.Errorf("%w: %s（%s）", ErrServerMissing, lang.Server, lang.InstallHint)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if p.closed {
		return Info{}, errors.New("进程池已关闭")
	}
	if existing, ok := p.sessions[abs]; ok {
		return existing.info(), nil
	}
	if len(p.sessions) >= p.maxSessions {
		return Info{}, ErrTooManySessions
	}

	s := &session{pool: p, root: abs, language: lang, server: serverPath}
	if err := s.start(); err != nil {
		return Info{}, err
	}
	p.sessions[abs] = s
	// 进程起来了但还没有客户端：从这一刻开始计时，超时没人连就回收。
	s.armIdle()
	return s.info(), nil
}

// Attach 把一个客户端接到该工作区的会话上。
//
// 同一工作区同时只允许一个客户端：两个客户端各自 initialize 会让服务端的
// 文档状态互相覆盖，而这类错乱只在下次保存时才被看见。
//
// Args:
//
//	root: 工作区根
//
// Returns:
//
//	连接句柄；未 Ensure 过、已有客户端或进程已无法重启时返回错误。
func (p *Pool) Attach(root string) (*Conn, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("解析工作区路径失败: %w", err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	s, ok := p.sessions[abs]
	if !ok {
		return nil, ErrSessionNotFound
	}

	s.mu.Lock()
	if s.attached {
		s.mu.Unlock()
		return nil, ErrAlreadyAttached
	}
	if s.state == StateFailed {
		errText := s.lastError
		s.mu.Unlock()
		return nil, fmt.Errorf("语言服务器已停止重试：%s", errText)
	}
	frames := s.frames
	if frames == nil {
		s.mu.Unlock()
		return nil, ErrRestarting
	}
	// 连上了说明客户端可用，把崩溃计数清零；否则一次偶发崩溃会让这个
	// 工作区在后续整个会话里都容易"用完重试次数"。
	s.restarts = 0
	s.attached = true
	s.hadClient = true
	s.clearIdle()
	s.mu.Unlock()

	return &Conn{pool: p, session: s, frames: frames, closed: make(chan struct{})}, nil
}

// Sessions 返回所有会话的快照，按启动时间从早到晚排列。
func (p *Pool) Sessions() []Info {
	p.mu.Lock()
	defer p.mu.Unlock()

	list := make([]Info, 0, len(p.sessions))
	for _, s := range p.sessions {
		list = append(list, s.info())
	}
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j].StartedAt < list[j-1].StartedAt; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
	return list
}

// Stop 停止并移除一个工作区的会话。
//
// Args:
//
//	root: 工作区根
//
// Returns:
//
//	会话不存在时返回 ErrSessionNotFound；进程已被强杀也算成功。
func (p *Pool) Stop(root string) error {
	abs, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("解析工作区路径失败: %w", err)
	}

	p.mu.Lock()
	s, ok := p.sessions[abs]
	if ok {
		delete(p.sessions, abs)
	}
	p.mu.Unlock()

	if !ok {
		return ErrSessionNotFound
	}
	s.shutdown()
	return nil
}

// Restart 强杀并重新拉起一个工作区的服务器。
//
// 用于用户手动介入：崩溃次数用尽（StateFailed）或改完项目配置之后。
//
// Args:
//
//	root: 工作区根
//
// Returns:
//
//	重启后的快照；会话不存在或重新拉起失败时返回错误。
func (p *Pool) Restart(root string) (Info, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return Info{}, fmt.Errorf("解析工作区路径失败: %w", err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	s, ok := p.sessions[abs]
	if !ok {
		return Info{}, ErrSessionNotFound
	}
	s.stopProcess()
	s.mu.Lock()
	s.restarts = 0
	s.lastError = ""
	s.state = StateStarting
	s.mu.Unlock()

	if err := s.start(); err != nil {
		return Info{}, err
	}
	s.armIdle()
	return s.info(), nil
}

// Close 停掉所有会话。进程池不可再用。
func (p *Pool) Close() {
	p.mu.Lock()
	sessions := make([]*session, 0, len(p.sessions))
	for _, s := range p.sessions {
		sessions = append(sessions, s)
	}
	p.sessions = make(map[string]*session)
	p.closed = true
	p.mu.Unlock()

	for _, s := range sessions {
		s.shutdown()
	}
}

// remove 在会话的进程彻底退出后把它从表里摘掉。
func (p *Pool) remove(s *session) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if cur, ok := p.sessions[s.root]; ok && cur == s {
		delete(p.sessions, s.root)
	}
}

// session 是一个工作区的服务器进程及其连接状态。
type session struct {
	pool     *Pool
	root     string
	language Language
	server   string

	mu sync.Mutex
	// cmd/stdin/frames 属于当前这一代进程；重启时整体替换。
	cmd   *exec.Cmd
	stdin io.WriteCloser
	// frames 属于当前这一代进程；重启时整体替换。
	frames chan []byte
	// exited 在当前这一代进程彻底退出后关闭。
	//
	// 有它才能在 Stop/Close 里确认"进程真的没了"：Windows 上工作区目录要等
	// 进程释放句柄才能删，杀掉就返回会让调用方拿到"文件被占用"。
	exited chan struct{}
	// generation 每拉起一次进程自增，用来让上一代的退出回调失效。
	generation int
	stopped    bool
	attached   bool
	// hadClient 记录这个会话是否曾经被客户端连过。
	//
	// 崩溃后 attached 会被清掉（旧连接已经作废，客户端要重新 Attach），但
	// "要不要重启"必须看历史上有没有人在用：没有人用就说明这是预热后没人连，
	// 直接回收；有人用过就得继续尝试，直到重试次数用尽。
	hadClient bool
	state     string
	restarts  int
	lastError string
	startedAt time.Time
	idle      *time.Timer
	writeMu   sync.Mutex
}

// start 拉起进程并启动读循环。调用方需持有池锁。
func (s *session) start() error {
	ctx, cancel := context.WithCancel(context.Background())

	cmd := s.pool.command(ctx, s.server, s.language.Args()...)
	// 语言服务器都是控制台程序：桌面端是 GUI 子系统进程，不隐藏就会
	// 每起一个会话闪一个黑框。
	noconsole.Hide(cmd)
	cmd.Dir = s.root

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("连接语言服务器 stdin 失败: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("连接语言服务器 stdout 失败: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("连接语言服务器 stderr 失败: %w", err)
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("启动语言服务器失败（%s）: %w", s.server, err)
	}

	frames := make(chan []byte, frameQueue)
	exited := make(chan struct{})
	s.mu.Lock()
	s.cmd = cmd
	s.stdin = stdin
	s.frames = frames
	s.exited = exited
	s.state = StateRunning
	s.startedAt = time.Now()
	s.generation++
	gen := s.generation
	s.mu.Unlock()

	go s.readLoop(gen, cmd, frames, exited, stdout, stderr, cancel)
	return nil
}

// tailBuffer 只保留写入内容的最后一段。
//
// stderr 必须整条读空（否则服务器写日志时会把管道写满而卡死），但真正有
// 用的只有结尾那几行崩溃栈，前面几千行初始化日志留着也没人看。
type tailBuffer struct {
	mu   sync.Mutex
	data []byte
	max  int
}

// Write 实现 io.Writer：把新内容追加进尾部窗口。
func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.data = append(t.data, p...)
	if len(t.data) > t.max {
		t.data = append(t.data[:0], t.data[len(t.data)-t.max:]...)
	}
	return len(p), nil
}

// String 返回当前保留的尾部内容。
func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.data)
}

// readLoop 把 stdout 的帧推进队列，并在进程退出后收尾。
func (s *session) readLoop(gen int, cmd *exec.Cmd, frames chan []byte, exited chan struct{}, stdout, stderr io.Reader, cancel context.CancelFunc) {
	defer cancel()
	defer close(exited)

	// stderr 单独抽干：语言服务器会往这里写初始化日志与崩溃栈，不读它会让
	// 进程在管道写满时卡死；同时留一份给用户看真正的原因。
	tail := &tailBuffer{max: stderrTail}
	stderrDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(tail, stderr)
		close(stderrDone)
	}()

	r := bufio.NewReaderSize(stdout, readBufferSize)
	consumed := true
	for consumed {
		body, err := ReadFrame(r)
		if err != nil {
			break
		}
		select {
		case frames <- body:
		default:
			// 队列满说明消费端停了。在这里丢帧会破坏 LSP 的请求-响应配对，
			// 不如结束会话，让客户端重连拿到干净状态。
			consumed = false
		}
	}

	_ = cmd.Wait()
	close(frames)
	<-stderrDone
	s.onExit(gen, tail.String())
}

// onExit 处理进程退出：状态收尾，并在需要时退避重启。
func (s *session) onExit(gen int, stderrText string) {
	s.mu.Lock()
	if gen != s.generation {
		// 上一代进程的退出，当前这一代已经接管，忽略。
		s.mu.Unlock()
		return
	}
	stopped := s.stopped
	hadClient := s.hadClient
	if !stopped && strings.TrimSpace(stderrText) != "" {
		s.lastError = strings.TrimSpace(stderrText)
	}
	s.attached = false
	s.frames = nil
	s.stdin = nil
	if stopped {
		s.state = StateFailed
	}
	s.mu.Unlock()

	if stopped {
		return
	}
	if !hadClient {
		// 从来没有客户端连过：预热完没人用，或者客户端正常断开（那条路径直接
		// Stop，不走这里）。不必重启，摘掉即可。
		s.pool.remove(s)
		return
	}
	s.scheduleRestart(gen)
}

// scheduleRestart 按退避序列重拉进程。
func (s *session) scheduleRestart(gen int) {
	s.mu.Lock()
	if s.stopped || s.generation != gen {
		s.mu.Unlock()
		return
	}
	if s.restarts >= len(s.pool.restartDelays) {
		s.state = StateFailed
		if s.lastError == "" {
			s.lastError = fmt.Sprintf("语言服务器连续异常退出 %d 次", s.restarts+1)
		}
		s.mu.Unlock()
		return
	}
	delay := s.pool.restartDelays[s.restarts]
	s.restarts++
	s.state = StateRestarting
	s.mu.Unlock()

	time.AfterFunc(delay, func() {
		s.mu.Lock()
		if s.stopped || s.generation != gen {
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()

		s.pool.mu.Lock()
		defer s.pool.mu.Unlock()
		if s.stopped {
			return
		}
		if err := s.start(); err != nil {
			s.mu.Lock()
			s.lastError = err.Error()
			newGen := s.generation
			s.mu.Unlock()
			s.scheduleRestart(newGen)
			return
		}
		// 新进程起来了，等客户端重连；没人来就连同进程一起回收。
		s.armIdle()
	})
}

// armIdle 在无客户端连接时启动回收计时。调用方需持有池锁。
func (s *session) armIdle() {
	s.mu.Lock()
	s.clearIdle()
	s.idle = time.AfterFunc(s.pool.idleTimeout, func() {
		s.mu.Lock()
		attached := s.attached
		s.mu.Unlock()
		if attached {
			return
		}
		_ = s.pool.Stop(s.root)
	})
	s.mu.Unlock()
}

// clearIdle 取消回收计时。调用方需持有 s.mu。
func (s *session) clearIdle() {
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
}

// lastErrorText 在当前无锁的调用点安全取一次错误文本。
func (s *session) lastErrorText() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastError
}

// shutdown 停掉进程并标记为已停，避免被当成崩溃重启。
func (s *session) shutdown() {
	s.mu.Lock()
	s.stopped = true
	s.attached = false
	s.clearIdle()
	stdin := s.stdin
	cmd := s.cmd
	exited := s.exited
	s.mu.Unlock()

	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	// 等进程真的退干净再返回：它是以工作区为 cwd 起的，Windows 上不等到
	// 句柄释放，调用方删目录就会撞上"文件被占用"。
	waitExited(exited)
}

// stopProcess 停掉当前进程但保留会话（重启前调用）。调用方需持有池锁。
func (s *session) stopProcess() {
	s.mu.Lock()
	stdin := s.stdin
	cmd := s.cmd
	exited := s.exited
	// 自增代次：旧进程的 onExit 看到代次不匹配就不会触发重启，也不会去动
	// 池锁——所以这里可以安全地等它退出。
	s.generation++
	s.clearIdle()
	s.mu.Unlock()

	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	waitExited(exited)
}

// waitExited 等待进程退出，最多 3 秒。
//
// 超时不算错误：Kill 之后卡住的是极小概率的外部因素（调试器、僵尸句柄），
// 为它无限期挂住整个进程池不值得。
func waitExited(exited chan struct{}) {
	if exited == nil {
		return
	}
	select {
	case <-exited:
	case <-time.After(3 * time.Second):
	}
}

// info 返回快照。调用方需持有池锁。
func (s *session) info() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Info{
		Root:      s.root,
		Language:  s.language.ID,
		Server:    s.server,
		State:     s.state,
		Attached:  s.attached,
		Restarts:  s.restarts,
		LastError: s.lastError,
		StartedAt: s.startedAt.UnixMilli(),
	}
}

// Conn 是一次客户端连接的句柄。
type Conn struct {
	pool    *Pool
	session *session
	frames  chan []byte
	closed  chan struct{}
	once    sync.Once
}

// Frames 返回服务端消息队列；进程退出或会话关闭时被关闭。
func (c *Conn) Frames() <-chan []byte { return c.frames }

// Closed 在连接失效（进程退出、会话被停）时关闭。
func (c *Conn) Closed() <-chan struct{} { return c.closed }

// Send 把一条消息体写成帧发给服务器。
func (c *Conn) Send(body []byte) error {
	c.session.mu.Lock()
	stdin := c.session.stdin
	c.session.mu.Unlock()
	if stdin == nil {
		return errors.New("语言服务器进程已退出")
	}
	c.session.writeMu.Lock()
	defer c.session.writeMu.Unlock()
	return WriteFrame(stdin, body)
}

// Close 断开连接。
//
// 进程随之退出：LSP 的 initialize 是一次性的，同一个进程没法给第二个客户端
// 重新握手，保留暖进程也用不上。真正的暖启动要等客户端支持连接复用。
func (c *Conn) Close() {
	c.once.Do(func() { close(c.closed) })

	c.session.mu.Lock()
	c.session.attached = false
	c.session.mu.Unlock()

	_ = c.pool.Stop(c.session.root)
}
