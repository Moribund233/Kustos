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
	"path/filepath"
	"sync"

	"github.com/kustos/kustos-desktop/internal/bridge"
	"github.com/kustos/kustos-desktop/internal/platform/singleinstance"
	"github.com/kustos/kustos-desktop/internal/store"
	"github.com/kustos/kustos-desktop/internal/windowstate"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// mainWindowKey 是主窗口状态在本地库里的 key。
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
}

// Desktop 是装配好的桌面端。
type Desktop struct {
	app    *application.App
	bridge *bridge.Server
	window *application.WebviewWindow
	saver  *windowstate.Saver
	db     *store.DB

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

	d := &Desktop{db: opts.DB, screens: systemScreens}

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
			// 常驻应用应当关窗即收进托盘，但那需要托盘与常驻生命周期，
			// 当前先按"关窗退出"处理，避免留下半成品行为。
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		Windows: application.WindowsOptions{
			// 远程调试只在显式设置环境变量时开启，见 cdp.go 的说明：
			// 这条能力的收益是能用 CDP/Playwright 直接驱动真实 WebView，
			// 代价是渲染进程连同 access token 向本机开放，因此不进发布产物。
			AdditionalBrowserArgs: browserArgs(),
			WebviewUserDataPath:   webviewDir,
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

	d.createMainWindow()
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
func (d *Desktop) createMainWindow() {
	st := windowstate.Restore(d.db, mainWindowKey, d.screens())

	winOpts := application.WebviewWindowOptions{
		Title: "Kustos",
		// 窗口加载 bridge 地址而非资产服务器：同源能力是全盘走 bridge 的前提。
		// 带一次性引导令牌，首个请求据此换取 nonce cookie，之后的请求靠 cookie 校验。
		URL:              d.bridge.EntryURL(),
		X:                st.X,
		Y:                st.Y,
		Width:            st.Width,
		Height:           st.Height,
		BackgroundColour: application.NewRGB(10, 17, 21), // --color-ink-900

		// 无边框：标题栏由前端自绘（38px，含品牌、上下文 chip、连接灯、
		// 搜索与窗口控制）。系统标题栏在这里是纯冗余——它会和白骨色的
		// 内容区割裂，也放不下原型要表达的分支/PR 上下文。
		//
		// 拖拽靠 CSS 的 `-webkit-app-region: drag`（见 globals.css），
		// 按钮与输入框用 `no-drag` 挖掉，否则点击会被当成拖拽。
		Frameless: true,
	}
	if st.Maximised {
		winOpts.StartState = application.WindowStateMaximised
	}

	win := d.app.Window.NewWithOptions(winOpts)
	d.window = win

	// 窗口状态的保存去抖：拖动时 move/resize 会连续触发上百次，
	// 逐次写库是明显的写放大。
	d.saver = windowstate.NewSaver(func(s windowstate.State) error {
		return windowstate.Save(d.db, mainWindowKey, s)
	}, 0)

	record := func(*application.WindowEvent) {
		d.saveWindowState()
	}
	for _, et := range []events.WindowEventType{
		events.Common.WindowDidMove,
		events.Common.WindowDidResize,
		events.Common.WindowMaximise,
		events.Common.WindowUnMaximise,
		events.Common.WindowRestore,
	} {
		win.OnWindowEvent(et, record)
	}
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
// 而"拖完就关"恰恰是最常见的路径。
func (d *Desktop) persistWindowState() {
	if d.saver != nil {
		_ = d.saver.Flush()
		d.saver.Close()
	}
}

// handleSecondLaunch 处理第二实例的启动请求。
//
// Args:
//
//	data: 第二实例传来的参数（来自本机其它进程，按不可信输入处理）
//
// 当前没有深链路由，因此只做一件事：把已有窗口唤到前面。
// 这正是用户双击图标时期望的结果，也避免了第二个进程持有同一份本地库。
func (d *Desktop) handleSecondLaunch(_ application.SecondInstanceData) {
	// 参数来自本机其它进程，一律视为不可信。当前没有深链路由，因此不解析
	// 任何参数，只做用户双击图标时期望的那件事：把已有窗口唤到前面。
	// 这样也避免了第二个进程持有同一份本地库、在 UI 状态上互相覆盖。
	if d.window == nil {
		return
	}
	d.window.Show()
	d.window.Focus()
}

// Run 启动事件循环（阻塞直到退出）。
func (d *Desktop) Run() error {
	defer func() {
		if d.bridge != nil {
			_ = d.bridge.Close()
		}
	}()
	return d.app.Run()
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
