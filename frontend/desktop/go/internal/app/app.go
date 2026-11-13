// Package app 负责桌面端进程的装配：窗口、bridge、生命周期。
//
// 职责边界：本包只管"本机怎么把界面端起来"，不含任何业务判断。
// 业务能力在 services 层，安全边界在 bridge 层。
package app

import (
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"sync"

	"github.com/kustos/kustos-desktop/internal/bridge"
	"github.com/kustos/kustos-desktop/internal/platform/deeplink"
	"github.com/kustos/kustos-desktop/internal/platform/singleinstance"
	"github.com/kustos/kustos-desktop/internal/services"
	"github.com/kustos/kustos-desktop/internal/store"
	"github.com/kustos/kustos-desktop/internal/windowstate"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// mainWindowKey 是主窗口状态在本地库里的 key。
//
// 完整映射见 windows.go 的 windowKeys：每种窗口各有自己的几何。
const mainWindowKey = "window.main"

// Options 是装配参数。
type Options struct {
	// Assets 是嵌入的前端产物。
	Assets embed.FS
	// AssetDir 是 Assets 内的产物目录。
	AssetDir string
	// Services 是要绑定给前端的能力服务。
	Services []application.Service
	// DB 是本地库，用于窗口状态持久化。
	DB *store.DB
	// DataDir 是本机数据目录；WebView2 的用户数据目录放在它下面。
	DataDir string
	// Logger 是 Wails 系统日志记录器；nil 表示丢弃。
	Logger *slog.Logger
	// Upstream 是默认实例地址；为空时 bridge 仍会启动，指向一个占位地址，
	// 由 SetUpstream 在用户选定实例后替换。
	Upstream string
	// LSP 是本地语言服务器端点（`/lsp/*`）的处理器；nil 时这些路径返回 501。
	//
	// 由装配层构造后注入，而不是在 app 内部建：进程池要用到"能不能在这个
	// 工作区里跑代码"的判断，那依赖本地库，属于服务层的职责。
	LSP http.Handler
}

// Desktop 是装配好的桌面端。
type Desktop struct {
	app    *application.App
	bridge *bridge.Server
	window *application.WebviewWindow
	saver  *windowstate.Saver
	db     *store.DB

	// registry 按 Name 复用窗口：主窗口与评审窗各只有一个实例。
	registry *windowRegistry
	// tray 是托盘图标与菜单；关窗后从它回来。
	tray *tray
	// savers 是各窗口的几何去抖器，退出前统一 Flush。
	saversMu sync.Mutex
	savers   []*windowstate.Saver

	// pendingSurface 是深链要求落到、但前端还没消费的分区。
	// 前端启动后主动读一次，覆盖"事件发出时监听器还没注册"的窗口。
	pendingMu      sync.Mutex
	pendingSurface string

	// screens 返回当前可用屏幕，抽出来是为了让装配逻辑可测试。
	screens func() []windowstate.Rect

	// assetsOnce 保证资产链只捕获一次（Wails 可能多次调用中间件构造）。
	assetsOnce sync.Once
}

// New 装配并返回桌面端实例（不启动事件循环）。
//
// Args:
//
//	opts: 装配参数
//
// Returns:
//
//	装配好的桌面端；前端产物缺失或 bridge 启动失败时返回错误。
func New(opts Options) (*Desktop, error) {
	dist, err := fs.Sub(opts.Assets, opts.AssetDir)
	if err != nil {
		return nil, fmt.Errorf("定位前端产物失败（先构建 web）: %w", err)
	}

	// 静态资源走 bridge 的本地分支，保证与 /api 同源——
	// 这是"前端代码与 Web 同构"的前提：共享层不必为桌面端加传输分支。
	assets := http.FileServer(http.FS(dist))

	d := &Desktop{
		db:       opts.DB,
		screens:  systemScreens,
		registry: newWindowRegistry(),
		tray:     newTray(),
	}

	// WebView2 的用户数据目录放在本机数据目录下：与本地库同级，便于备份与清理。
	webviewDir := ""
	if opts.DataDir != "" {
		webviewDir = filepath.Join(opts.DataDir, webviewProfileName)
	}

	// bridge 始终启动，即使还不知道上游地址：窗口必须加载到 bridge 的地址，
	// 否则 WebView 里的 fetch("/api/v1/...") 会打到 Wails 资产服务器上变成 404。
	// 未选定实例时先指向一个明确的占位上游，等用户填完地址再 SetUpstream。
	upstream := opts.Upstream
	if upstream == "" {
		upstream = placeholderUpstream
	}
	b, err := bridge.New(upstream, assets)
	if err != nil {
		return nil, fmt.Errorf("启动 bridge 失败: %w", err)
	}
	d.bridge = b

	// 语言服务器端点在这里就接上：它是进程内的 WebSocket 处理器，不依赖
	// Wails 的启动阶段（与 IPC 端点不同），早接上早能用。
	if opts.LSP != nil {
		b.SetLSPHandler(opts.LSP)
	}

	app := application.New(application.Options{
		Name:        "Kustos Desktop",
		Description: "Kustos 桌面端：改、跑、收的工作台",
		Services:    opts.Services,
		Logger:      opts.Logger,
		// 单实例：常驻应用被双击第二次时唤出已有窗口，而不是再起一个进程
		// 各自持有一份本地库连接，在 UI 状态上互相覆盖。
		SingleInstance: singleinstance.Options(d.handleSecondLaunch),
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(opts.Assets),
			// 捕获 Wails 组装好的完整资产链（含 `/wails/runtime` 的 IPC 端点），
			// 再转交给 bridge。窗口加载的是 bridge 地址，前端调用 Go 方法走
			// `POST /wails/runtime`——不把这条链路接过去，界面上每个按钮都会
			// 拿到 404，而这看起来像后端接口挂了。
			Middleware: func(next http.Handler) http.Handler {
				d.captureAssets(next)
				return next
			},
		},
		Mac: application.MacOptions{
			// 关掉最后一个窗口不等于退出：主窗口只是收进托盘，退出是托盘里的
			// 显式动作。设成 true 会让 macOS 在关窗时直接终止进程，
			// 用户再点托盘图标就没有进程可唤了。
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		Windows: application.WindowsOptions{
			// 远程调试只在显式设置环境变量时开启，见 cdp.go 的说明：
			// 这条能力的收益是能用 CDP/Playwright 直接驱动真实 WebView，
			// 代价是渲染进程连同 access token 向本机开放，因此不进发布产物。
			AdditionalBrowserArgs: browserArgs(),
			WebviewUserDataPath:   webviewDir,
			// 与 mac 同一个理由，这里是 Windows 上的开关：关掉主窗口只收起，
			// 进程继续活在托盘里。
			DisableQuitOnLastWindowClosed: true,
		},
		OnShutdown: d.persistWindowState,
	})
	d.app = app

	// 单实例判定在 application.New 里，第二个实例到这里前已经退出；
	// 此时再等 WebView2 目录，才不会把"自己就是第二实例"当成占用。
	if webviewDir != "" {
		if err := waitWebviewProfile(webviewDir, webviewProfileWait); err != nil {
			return nil, err
		}
	}

	if err := d.createMainWindow(); err != nil {
		return nil, err
	}
	return d, nil
}

// captureAssets 记录 Wails 组装好的资产链，并转交给 bridge。
//
// 为什么需要：窗口加载的是 bridge 地址（为了与 `/api` 同源），而前端调用
// Go 方法的绑定请求走 `POST /wails/runtime`。这条请求先到 bridge，
// 只有把它交给 Wails 自己的处理器才能拿到响应；否则每个按钮都 404，
// 而界面看起来一切正常，排查时极易误判成后端挂了。
//
// Wails 的资产服务器是私有字段，没有公开访问器，但它会把组装好的链作为
// `next` 传给用户中间件——这里正好是唯一能拿到完整链的位置。
func (d *Desktop) captureAssets(next http.Handler) {
	d.assetsOnce.Do(func() {
		if d.bridge != nil {
			d.bridge.SetIPCHandler(next)
		}
	})
}

// placeholderUpstream 是尚未选定实例时的占位上游。
//
// 用保留的不可路由地址而不是空串：bridge.New 要求合法 URL，
// 且任何真实请求都应当明确失败，而不是被悄悄发去某个真实主机。
const placeholderUpstream = "http://127.0.0.1:1"

// createMainWindow 创建主窗口并接上状态保存。
func (d *Desktop) createMainWindow() error {
	win, err := d.createWindow(WindowKindMain)
	if err != nil {
		return err
	}
	d.window = win
	d.saver = windowstate.NewSaver(func(s windowstate.State) error {
		return windowstate.Save(d.db, windowStateKey(WindowKindMain), s)
	}, 0)

	record := func(*application.WindowEvent) {
		d.saveWindowState()
	}
	for _, et := range windowEventTypes {
		win.OnWindowEvent(et, record)
	}
	return nil
}

// createWindow 按种类创建窗口，每个窗口各自取自己的几何状态。
//
// Args:
//
//	kind: 窗口种类
//
// Returns:
//
//	新建的窗口；入口地址换发失败时返回错误。
//
// 每个窗口都要自己的入口地址：入口令牌是一次性的，多个窗口共用同一个地址时
// 只有先导航的那个能换到 cookie，后一个会被同源校验挡成 401。
func (d *Desktop) createWindow(kind WindowKind) (*application.WebviewWindow, error) {
	// 走同一个地址构造函数：片段由种类决定，不在这里另抄一份拼接逻辑，
	// 否则主窗口与评审窗迟早会有一边漏掉片段。
	entry, err := d.windowEntryURL(kind, "")
	if err != nil {
		return nil, err
	}
	return d.createWindowWithURL(kind, entry)
}

// createWindowWithURL 用给定地址创建窗口。
//
// Args:
//
//	kind:     窗口种类，决定窗口名、标题与状态 key
//	entryURL: 这次导航要用的地址（带引导令牌，可能还带内容片段）
//
// Returns:
//
//	新建的窗口。
func (d *Desktop) createWindowWithURL(kind WindowKind, entryURL string) (*application.WebviewWindow, error) {
	st := windowstate.Restore(d.db, windowStateKey(kind), d.screens())

	winOpts := application.WebviewWindowOptions{
		Name:  string(kind),
		Title: windowTitle(kind),
		// 窗口加载 bridge 地址而非资产服务器：同源能力是全盘走 bridge 的前提。
		// 带一次性引导令牌，首个请求据此换取 nonce cookie，之后的请求靠 cookie 校验。
		URL:              entryURL,
		X:                st.X,
		Y:                st.Y,
		Width:            st.Width,
		Height:           st.Height,
		BackgroundColour: application.NewRGB(10, 17, 21), // --color-ink-900

		// 无边框：标题栏由前端自绘（38px，含品牌、上下文 chip、连接灯、
		// 搜索与窗口控制）。系统标题栏在这里是纯冗余——它会和白骨色的
		// 内容区割裂，也放不下原型要表达的分支/PR 上下文。
		Frameless: true,
		Windows: application.WindowsWindow{
			// WebView2 原生的非客户区命中测试。
			//
			// 不开这个开关，前端用 `--wails-non-client-region: caption`
			// 标出的拖拽区域**完全无效**：窗口表现为"点标题栏拖不动"，
			// 而界面看起来一切正常。默认值是 false，必须显式打开。
			NonClientRegionSupport: true,
			// 无边框自定义标题栏需要把 WebView2 切到视觉托管
			// （CompositionController + DirectComposition）。
			//
			// 这一项不是可选的：Wails v3 把前端的
			// `window._wails.flags.nonClientRegionTracking` **硬编码**绑定到
			// 这个字段（见 webview_window_windows.go 的 flags 注入），
			// 只开 NonClientRegionSupport 时该标志仍为 false，
			// 拖拽区域根本不会上报给原生层。
			WebView2CompositionHosting: true,
		},
	}
	if st.Maximised {
		winOpts.StartState = application.WindowStateMaximised
	}

	win := d.app.Window.NewWithOptions(winOpts)
	d.registry.markOpen(kind)
	d.attachWindowPersistence(win, kind)
	return win, nil
}

// windowTitle 返回窗口标题。
func windowTitle(kind WindowKind) string {
	switch kind {
	case WindowKindReview:
		return "Kustos — 评审"
	default:
		return "Kustos"
	}
}

// attachWindowPersistence 给某个窗口接上几何持久化与关闭语义。
//
// Args:
//
//	win:  目标窗口
//	kind: 窗口种类，决定状态 key 与关闭行为
func (d *Desktop) attachWindowPersistence(win *application.WebviewWindow, kind WindowKind) {
	key := windowStateKey(kind)
	saver := windowstate.NewSaver(func(s windowstate.State) error {
		return windowstate.Save(d.db, key, s)
	}, 0)
	d.registerSaver(saver)

	record := func(*application.WindowEvent) {
		b := win.Bounds()
		st := windowstate.State{
			X:         b.X,
			Y:         b.Y,
			Width:     b.Width,
			Height:    b.Height,
			Maximised: win.IsMaximised(),
		}
		// 最小化时窗口边界会变成 0，存下去等于把窗口尺寸抹掉。
		if st.Width < windowstate.MinWidth || st.Height < windowstate.MinHeight {
			return
		}
		saver.Schedule(st)
	}
	for _, et := range windowEventTypes {
		win.OnWindowEvent(et, record)
	}

	// 关闭语义必须用 RegisterHook 而不是 OnWindowEvent：hooks 在 UI 线程里
	// **同步**执行，事件被 Cancel 后 HandleWindowEvent 直接返回，Wails 内建的
	// "真正销毁窗口"监听器不会跑。OnWindowEvent 的监听器在独立 goroutine 里，
	// 那时窗口已经关了，Cancel 不起作用。
	if hidableOnClose(kind) {
		win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
			e.Cancel()
			win.Hide()
		})
	} else {
		win.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) {
			d.registry.markClosed(kind)
		})
	}
}

// OpenWindow 打开（或聚焦）指定种类的窗口。
//
// 已存在时只唤到前面，不重复创建——每种窗口只应有一个实例，否则用户连点两次
// 会得到两个各自持有独立状态的窗口。
//
// Args:
//
//	kind: 窗口种类（main / review）
//
// Returns:
//
//	种类无法识别时返回错误。
func (d *Desktop) OpenWindow(kind WindowKind) error {
	return d.OpenWindowWith(kind, "")
}

// OpenWindowWith 打开（或聚焦）指定种类的窗口，并带上该窗口要显示的内容标识。
//
// 为什么需要内容标识：评审窗不是主窗口的副本，它要显示"哪一个 PR"。标识经 URL
// 片段传给前端（`#/review/42`），而不是靠全局状态——多窗口下的全局状态由最后
// 写入者胜出，两个评审窗会显示同一个 PR，而它们本该各看各的。
//
// 已存在的窗口会**替换**它当前的内容标识并重新导航：用户点了另一个 PR 的
// "在窗口中打开"，期望是这个窗口换过去，而不是什么都不发生。
//
// Args:
//
//	kind: 窗口种类（main / review）
//	route: 窗口内容标识，如 "42"；空串表示不带
//
// Returns:
//
//	种类无法识别或创建失败时返回错误。
func (d *Desktop) OpenWindowWith(kind WindowKind, route string) error {
	if kind == WindowKindMain {
		d.ShowMainWindow()
		return nil
	}

	entry, err := d.windowEntryURL(kind, route)
	if err != nil {
		return err
	}

	if existing := d.registry.existing(d.app, kind); existing != nil {
		// 已有窗口：换内容再唤出来。只 Show 不导航的话，用户点第二个 PR 的
		// "在窗口中打开"会看到上一次那个 PR，还以为点错了。
		if route != "" {
			existing.SetURL(entry)
		}
		existing.Show()
		existing.Focus()
		return nil
	}

	win, err := d.createWindowWithURL(kind, entry)
	if err != nil {
		return err
	}
	win.Show()
	win.Focus()
	return nil
}

// windowEntryURL 返回某个窗口这次导航要用的地址。
//
// 片段是窗口内容的唯一真相：前端只认地址里的 `#/review/...` 决定这一屏显示
// 什么，因此**每种窗口都必须带上自己的片段**，包括还不知道要显示哪个 PR 的
// 评审窗（托盘直接唤出的那种）。不带片段时前端无法区分"这是评审窗"和"这是
// 主窗口"，只会渲染成第二个主界面。
//
// Args:
//
//	kind:  窗口种类，决定片段里的 scope
//	route: 内容标识（如 PR 编号）；评审窗为空时仍带 `#/review`
//
// Returns:
//
//	带一次性引导令牌的完整地址；令牌换发失败时返回错误。
func (d *Desktop) windowEntryURL(kind WindowKind, route string) (string, error) {
	entry, err := d.bridge.EntryURL()
	if err != nil {
		return "", err
	}
	scope := windowRouteScope(kind)
	if scope == "" {
		return entry, nil
	}
	// 片段放在查询串之后，且不参与服务端的路径匹配——它只给前端读。
	// 用 PathEscape 兜住标识里可能出现的斜杠与空格。
	if route == "" {
		return entry + "#/" + scope, nil
	}
	return entry + "#/" + scope + "/" + url.PathEscape(route), nil
}

// ShowMainWindow 唤出主窗口（从托盘回来走这条路径）。
func (d *Desktop) ShowMainWindow() {
	if d.window == nil {
		if err := d.createMainWindow(); err != nil {
			return
		}
	}
	d.window.Show()
	d.window.Focus()
}

// CloseCurrentWindow 关闭当前活动窗口。
//
// 主窗口的关闭被关闭钩子改写成"收进托盘"，因此这里调 Close 与用户点关闭键
// 走同一条路径——两处各写一套隐藏逻辑迟早会漂移。
func (d *Desktop) CloseCurrentWindow() {
	if d.window == nil {
		return
	}
	d.window.Close()
}

// saveWindowState 读取当前窗口几何并登记一次待保存。
func (d *Desktop) saveWindowState() {
	if d.window == nil || d.saver == nil {
		return
	}
	b := d.window.Bounds()
	st := windowstate.State{
		X:         b.X,
		Y:         b.Y,
		Width:     b.Width,
		Height:    b.Height,
		Maximised: d.window.IsMaximised(),
	}
	// 最小化时窗口边界会变成 0，存下去等于把窗口尺寸抹掉；
	// 此时保留上一次的几何，只更新最大化标记。
	if st.Width < windowstate.MinWidth || st.Height < windowstate.MinHeight {
		return
	}
	d.saver.Schedule(st)
}

// persistWindowState 在退出前把待写状态落盘。
//
// 去抖器可能还在等待窗口内，此时直接退出会把用户最后一次拖动丢掉——
// 而"拖完就关"恰恰是最常见的路径。每个窗口各有一个去抖器，全部都要刷。
func (d *Desktop) persistWindowState() {
	d.saversMu.Lock()
	savers := append([]*windowstate.Saver(nil), d.savers...)
	d.saversMu.Unlock()

	for _, s := range savers {
		_ = s.Flush()
		s.Close()
	}
}

// registerSaver 登记一个窗口的几何去抖器，退出时统一刷盘。
func (d *Desktop) registerSaver(s *windowstate.Saver) {
	if s == nil {
		return
	}
	d.saversMu.Lock()
	defer d.saversMu.Unlock()
	d.savers = append(d.savers, s)
}

// handleSecondLaunch 处理第二实例的启动请求。
//
// Args:
//
//	data: 第二实例传来的参数（来自本机其它进程，按不可信输入处理）
//
// 参数里有一条 `kustos://` 深链时把它投递给本进程，否则只把已有窗口唤到前面。
// 两种情况都要唤窗口：用户双击图标时不需要链接就已经表达了"让我用这个应用"。
func (d *Desktop) handleSecondLaunch(data application.SecondInstanceData) {
	// 参数来自本机其它进程，一律视为不可信：解析失败就当作没有深链，
	// 退回"把窗口叫到前面"这个双击图标的默认语义。
	if raw, ok := deeplink.FindInArgs(data.Args); ok {
		d.OpenDeepLink(raw)
		return
	}
	d.ShowMainWindow()
}

// OpenDeepLink 按一条深链把界面切到对应位置。
//
// Args:
//
//	raw: `kustos://` 深链原文
//
// Returns:
//
//	深链形状不合法时返回错误；界面已经切过去时为 nil。
//
// 解析失败**不回落到默认屏**：一条打不开的链接应当能被发现，悄悄打开 Inbox
// 会让人以为链接生效了。调用方（第二实例路径）会忽略这个错误并唤出窗口，
// 因为"用户双击了应用"这件事本身仍然成立。
func (d *Desktop) OpenDeepLink(raw string) error {
	target, err := deeplink.Parse(raw)
	if err != nil {
		return err
	}
	// 评审深链要开第二个窗口，主窗口也一并唤出：评审窗不是主工作台的替代品。
	if target.Review != "" {
		if err := d.OpenWindowWith(WindowKindReview, target.Review); err != nil {
			return err
		}
	}
	d.ShowMainWindow()
	// 分区由前端路由决定，这里只把"要落到哪一屏"发过去。窗口可能刚创建、
	// 前端尚未挂上监听，因此前端在启动时还会读一次待处理目标（见 PendingSurface）。
	d.pendingMu.Lock()
	d.pendingSurface = target.Surface
	d.pendingMu.Unlock()
	if target.Surface != "" && d.app != nil {
		d.app.Event.Emit(DeeplinkNavigateEvent, target.Surface)
	}
	return nil
}

// PendingSurface 返回启动时收到、还没被前端消费的目标分区。
//
// Returns:
//
//	深链要求落到的分区；没有待处理目标时为空串。
//
// 为什么需要它：深链可能在窗口刚创建、前端脚本还没注册事件监听时到达，
// 那时 `EmitEvent` 发出去的事件没有任何接收者。前端启动后主动问一次，
// 两种情况就都覆盖到了。
func (d *Desktop) PendingSurface() string {
	d.pendingMu.Lock()
	defer d.pendingMu.Unlock()
	surface := d.pendingSurface
	d.pendingSurface = ""
	return surface
}

// Run 启动事件循环（阻塞直到退出）。
//
// 托盘在 app.Run() 之后才创建：Wails 的 SystemTray.Run 会检查应用是否已在运行，
// 早于事件循环调用则托盘根本不出现，而没有任何报错。
func (d *Desktop) Run() error {
	defer func() {
		if d.bridge != nil {
			_ = d.bridge.Close()
		}
	}()
	d.startTray()
	return d.app.Run()
}

// startTray 装配托盘并接上三个动作。
//
// 托盘创建必须延后到 app.Run() 内部：这里把它包成一个在事件循环启动后执行的
// 调用，而不是在 Run 之前直接建。
func (d *Desktop) startTray() {
	if d.tray == nil {
		return
	}
	d.tray.wire(d.ShowMainWindow, func() {
		_ = d.OpenWindow(WindowKindReview)
	}, func() {
		d.app.Quit()
	})
	// Wails 要求在事件循环里创建托盘；用 AfterStartup 排队而不是直接建。
	d.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		d.tray.setup(d.app)
	})
}

// TrayLabels 返回托盘当前文案，供服务层读取后转给前端。
func (d *Desktop) TrayLabels() (show, review, quit, tooltip string) {
	if d.tray == nil {
		labels := defaultTrayLabels()
		return labels.ShowMain, labels.Review, labels.Quit, labels.Tooltip
	}
	labels := d.tray.labelsSnapshot()
	return labels.ShowMain, labels.Review, labels.Quit, labels.Tooltip
}

// SetTrayLabels 更新托盘菜单文案。
//
// Args:
//
//	show、review、quit、tooltip: 新文案；空串表示保留原值
func (d *Desktop) SetTrayLabels(show, review, quit, tooltip string) {
	if d.tray == nil {
		return
	}
	d.tray.setLabels(trayLabels{ShowMain: show, Review: review, Quit: quit, Tooltip: tooltip})
}

// BridgeURL 返回 bridge 地址（未启用时为空），供测试与诊断使用。
func (d *Desktop) BridgeURL() string {
	if d.bridge == nil {
		return ""
	}
	return d.bridge.BaseURL()
}

// SetUpstream 切换 bridge 的上游实例。
//
// Returns:
//
//	地址非法时返回错误；失败时保留原有上游，不影响已连接的实例。
func (d *Desktop) SetUpstream(raw string) error {
	if d.bridge == nil {
		return fmt.Errorf("bridge 未启动")
	}
	return d.bridge.SetUpstream(raw)
}

// PickDirectory 打开系统目录选择框。
//
// 挂在 Desktop 上而不是服务层直接取 application.Get()：对话框要挂在具体窗口下，
// 否则 macOS 上会变成一个没有父窗口的浮动面板，Windows 上则可能被主窗口盖住。
//
// Args:
//
//	title: 对话框标题
//	start: 起始目录；为空则由系统决定
//
// Returns:
//
//	选中的绝对路径；用户取消时返回空字符串与 nil。
func (d *Desktop) PickDirectory(title, start string) (string, error) {
	if d.app == nil {
		return "", fmt.Errorf("桌面端尚未就绪")
	}
	dialog := d.app.Dialog.OpenFile()
	// 选择目录必须显式关掉"选文件"：Wails 默认是选文件的。
	dialog.CanChooseFiles(false)
	dialog.CanChooseDirectories(true)
	dialog.CanCreateDirectories(true)
	if title != "" {
		dialog.SetTitle(title)
	}
	if start != "" {
		dialog.SetDirectory(start)
	}
	if d.window != nil {
		dialog.AttachToWindow(d.window)
	}
	return dialog.PromptForSingleSelection()
}

// EmitCloneProgress 把克隆进度广播给界面。
//
// 由装配层转发而不是服务层直接调 application：服务层要能在没有 Wails 运行时的
// 测试里跑，而那里的 application.Get() 是 nil。
func (d *Desktop) EmitCloneProgress(ev services.CloneProgressEvent) {
	if d.app == nil {
		return
	}
	d.app.Event.Emit(cloneProgressEvent, ev)
}

// cloneProgressEvent 是克隆进度事件名，与 main.go 里 RegisterEvent 的一致。
const cloneProgressEvent = "clone:progress"

// DeeplinkNavigateEvent 是深链要求切换分区的广播事件名。
//
// 前端启动时还会调一次 PendingSurface 兜底：深链可能在窗口刚创建、
// 监听器还没注册时到达，那时广播没有任何接收者。
const DeeplinkNavigateEvent = "deeplink:navigate"
