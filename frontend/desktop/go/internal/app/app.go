// Package app 负责桌面端进程的装配：窗口、bridge、生命周期。
//
// 职责边界：本包只管"本机怎么把界面端起来"，不含任何业务判断。
// 业务能力在 services 层，安全边界在 bridge 层。
package app

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"

	"github.com/kustos/kustos-desktop/internal/bridge"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Options 是装配参数。
type Options struct {
	// Assets 是嵌入的前端产物。
	Assets embed.FS
	// AssetDir 是 Assets 内的产物目录。
	AssetDir string
	// Services 是要绑定给前端的能力服务。
	Services []application.Service
	// Upstream 是默认实例地址；为空时不启动 bridge（首次启动由用户填地址）。
	Upstream string
}

// Desktop 是装配好的桌面端。
type Desktop struct {
	app    *application.App
	bridge *bridge.Server
}

// New 装配并返回桌面端实例（不启动事件循环）。
func New(opts Options) (*Desktop, error) {
	dist, err := fs.Sub(opts.Assets, opts.AssetDir)
	if err != nil {
		return nil, fmt.Errorf("定位前端产物失败（先构建 web）: %w", err)
	}

	// 静态资源走 bridge 的本地分支，保证与 /api 同源——
	// 这是"前端代码与 Web 同构"的前提：共享层不必为桌面端加传输分支。
	assets := http.FileServer(http.FS(dist))

	d := &Desktop{}

	// bridge 只在已知实例地址时启动；首次启动由用户在界面上填地址，
	// 探活走 Go 直连（Probe），不依赖 bridge。
	if opts.Upstream != "" {
		b, err := bridge.New(opts.Upstream, assets)
		if err != nil {
			return nil, fmt.Errorf("启动 bridge 失败: %w", err)
		}
		d.bridge = b
	}

	app := application.New(application.Options{
		Name:        "Kustos Desktop",
		Description: "Kustos 桌面端：改、跑、收的工作台",
		Services:    opts.Services,
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(opts.Assets),
		},
		Mac: application.MacOptions{
			// 常驻应用应当关窗即收进托盘，但那需要托盘与常驻生命周期，
			// 当前先按"关窗退出"处理，避免留下半成品行为。
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	d.app = app

	// 主窗口：默认 1440×900。桌面端面向大屏常驻使用，
	// 窗口尺寸按信息密度优先取值，而不是网页常见的窄视口。
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "Kustos",
		Width:  1440,
		Height: 900,
		// 骨架阶段不设 URL，由 Wails 的资产服务器提供 index.html；
		// 接入 bridge 后改为 bridge 的地址以取得同源能力。
		URL:              "/",
		BackgroundColour: application.NewRGB(10, 17, 21), // --color-ink-900
	})

	return d, nil
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
