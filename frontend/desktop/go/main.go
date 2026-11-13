// Package main 是 Kustos 桌面端入口。
//
// 组装窗口、loopback bridge、本地存储与能力服务。
package main

import (
	"embed"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/kustos/kustos-desktop/internal/app"
	"github.com/kustos/kustos-desktop/internal/lsp"
	"github.com/kustos/kustos-desktop/internal/platform/diag"
	"github.com/kustos/kustos-desktop/internal/platform/keychain"
	"github.com/kustos/kustos-desktop/internal/services"
	"github.com/kustos/kustos-desktop/internal/store"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// 前端产物由 Vite 构建到 `web/dist`，再由 `pnpm build` 前的任务复制到
// `go/web/dist` 供嵌入。
//
// 为什么不在 go/ 里直接 embed `../web/dist`：Go 的 //go:embed 不允许 `..`，
// 嵌入路径必须位于本包目录之下。因此产物在构建期复制进来（见 Taskfile.yml
// 的 build 前置步骤），仓库里不提交这份副本。
//
// 前端产物**独立构建**并嵌入二进制，不加载网关的 dist：桌面端的导航、
// 密度与窗格与 Web 不同，共用一份产物会被迫取交集。
//
//go:embed all:web/dist
var assets embed.FS

func main() {
	// 事件类型注册：绑定生成器据此产出强类型 TS API。
	// 会话失效要广播到所有窗口，不只是主窗口。
	application.RegisterEvent[string]("session:lost")
	// 克隆进度：一次 clone 可能跑几分钟，进度要靠事件逐帧推给界面，
	// 因为 Wails 的一次方法调用只在结束时返回。
	application.RegisterEvent[services.CloneProgressEvent]("clone:progress")

	// 本地事实库与凭据存储：SQLite 存本机事实，凭据进系统钥匙串。
	dir, err := localDataDir()
	if err != nil {
		diag.Fatalf("定位本地数据目录失败: %v", err)
	}
	// 日志打不开不拦启动：界面能起来比留证据更要紧。
	logger, _ := diag.Setup(dir)

	dbPath := filepath.Join(dir, "kustos.db")
	db, err := store.Open(dbPath)
	if err != nil {
		diag.Fatalf("打开本地数据库失败（%s）: %v", dbPath, err)
	}
	defer func() { _ = db.Close() }()

	sessionSvc := services.NewSessionServiceWith(db, keychain.NewComposite())
	workingCopySvc := services.NewWorkingCopyService(db)

	// 语言服务器：进程池 + 本地端点。进程归 Go、协议归前端（见设计文档 §7.3），
	// 中间这一段只做 ws ↔ stdio 的转发。
	lspPool := lsp.NewPool(lsp.Options{})
	defer lspPool.Close()
	lspSvc := services.NewLSPService(db, lspPool)
	lspHandler := lsp.NewHandler(lspPool, func(root string) error {
		return services.AuthorizeWorkspace(db, root)
	})

	// 窗口与托盘服务的动作要等 desktop 建好才能接上，所以先声明再回填。
	windowSvc := services.NewWindowService()
	notificationSvc := services.NewNotificationService()
	systemSvc := services.NewSystemService()

	// 通知后端先接上再启动：Wails 在启动时初始化这个服务，
	// 晚于它接线会让第一批通知静默失败。
	services.BindNotifier(notifications.New())

	desktop, err := app.New(app.Options{
		Assets:   assets,
		AssetDir: "web/dist",
		DB:       db,
		DataDir:  dir,
		Logger:   logger,
		LSP:      lspHandler,
		Services: []application.Service{
			application.NewService(sessionSvc),
			application.NewService(workingCopySvc),
			application.NewService(windowSvc),
			application.NewService(notificationSvc),
			application.NewService(lspSvc),
			application.NewService(systemSvc),
		},
	})
	if err != nil {
		diag.Fatalf("初始化桌面端失败: %v", err)
	}

	// 回填窗口与托盘的实现：服务层只转发，真正的实现在 app 包。
	// 用包级绑定函数而不是服务方法，是为了不让装配动作出现在前端可调用的绑定里。
	services.BindWindowBackend(
		func(kind string) error {
			return desktop.OpenWindow(app.WindowKind(kind))
		},
		func(kind, route string) error {
			return desktop.OpenWindowWith(app.WindowKind(kind), route)
		},
		func() error {
			desktop.CloseCurrentWindow()
			return nil
		},
		desktop.TrayLabels,
		desktop.SetTrayLabels,
	)

	// 目录选择与克隆进度同样回填：服务层要能在没有 Wails 运行时的测试里跑，
	// 那里 application.Get() 是 nil，直连会让测试段疯狂。用包级绑定函数而不是
	// 服务方法，也是为了不让接线动作出现在前端可调用的绑定里。
	services.BindDirectoryPicker(desktop.PickDirectory)
	services.BindCloneProgress(desktop.EmitCloneProgress)

	// 联网 git 命令（clone / push / fetch）共用的凭据：从会话服务现取，不缓存。
	// 一次 clone 或 push 可能跑几分钟，期间令牌会被刷新，缓存下来就等于拿一枚
	// 过期令牌去访问远端；而 git 子进程没有 HTTP 那套 401 重试兜底。
	services.BindInstanceAuth(func() services.InstanceAuth {
		it, ok, err := sessionSvc.ActiveInstance()
		if err != nil || !ok {
			return services.InstanceAuth{}
		}
		return services.InstanceAuth{BaseURL: it.BaseURL, Token: sessionSvc.FreshAccessToken()}
	})

	// 会话层负责决定"现在用哪台实例"，bridge 负责把请求发过去。把后者注入
	// 给前者，用户添加或切换实例时上游才会跟着变；否则界面能登录成功，
	// 但之后所有接口请求都打在占位地址上。
	sessionSvc.UpstreamSetter = desktop.SetUpstream

	// 上次用过的实例在启动时就接到 bridge 上：否则用户看到的界面虽然还在，
	// 但所有接口请求都会打到占位上游而失败，得手动重连一次才恢复。
	if err := restoreActiveUpstream(db, desktop); err != nil {
		// 不是致命错误：界面会以"未连接实例"起步，用户仍可重新添加。
		log.Printf("恢复上次实例失败: %v", err)
	}

	if err := desktop.Run(); err != nil {
		diag.Fatalf("运行桌面端失败: %v", err)
	}
}

// restoreActiveUpstream 把上次使用的实例地址接到 bridge 上。
//
// 只取最近添加的一台：多实例并存是常态，但"上次用的那台"没有单独记录，
// 而按添加时间取最后一台在单实例使用时与用户预期一致。
// 真正的多实例切换由界面上的切换器完成，那里会显式调用 SetUpstream。
func restoreActiveUpstream(db *store.DB, desktop *app.Desktop) error {
	list, err := db.ListInstances()
	if err != nil {
		return fmt.Errorf("读取实例列表失败: %w", err)
	}
	if len(list) == 0 {
		return nil
	}
	return desktop.SetUpstream(list[len(list)-1].BaseURL)
}

// localDataDir 返回本机数据目录：本地库、启动日志与 WebView2 用户数据都放这里。
//
// 放在用户配置目录而非可执行文件旁：后者在 macOS 的 .app 包里是只读的，
// 在 Windows 的 Program Files 下同样不可写。
//
// `KUSTOS_DESKTOP_DATA_DIR` 可覆盖：一是让 CI/自动化能在沙箱允许的目录里跑，
// 二是排查"某个路径写不进去"时不必改代码。
func localDataDir() (string, error) {
	dir := os.Getenv("KUSTOS_DESKTOP_DATA_DIR")
	if dir == "" {
		configDir, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("找不到用户配置目录: %w", err)
		}
		dir = filepath.Join(configDir, "kustos-desktop")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("创建应用数据目录失败: %w", err)
	}
	return dir, nil
}
