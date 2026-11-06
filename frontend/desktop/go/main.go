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
	"github.com/kustos/kustos-desktop/internal/platform/keychain"
	"github.com/kustos/kustos-desktop/internal/services"
	"github.com/kustos/kustos-desktop/internal/store"
	"github.com/wailsapp/wails/v3/pkg/application"
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

	// 本地事实库与凭据存储：SQLite 存本机事实，凭据进系统钥匙串。
	dbPath, err := localDBPath()
	if err != nil {
		log.Fatalf("定位本地数据目录失败: %v", err)
	}
	db, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("打开本地数据库失败（%s）: %v", dbPath, err)
	}
	defer func() { _ = db.Close() }()

	desktop, err := app.New(app.Options{
		Assets:   assets,
		AssetDir: "web/dist",
		Services: []application.Service{
			application.NewService(services.NewSessionServiceWith(db, keychain.NewComposite())),
		},
	})
	if err != nil {
		log.Fatalf("初始化桌面端失败: %v", err)
	}

	if err := desktop.Run(); err != nil {
		log.Fatalf("运行桌面端失败: %v", err)
	}
}

// localDBPath 返回本地库路径。
//
// 放在用户配置目录而非可执行文件旁：后者在 macOS 的 .app 包里是只读的，
// 在 Windows 的 Program Files 下同样不可写。
//
// `KUSTOS_DESKTOP_DATA_DIR` 可覆盖：一是让 CI/自动化能在沙箱允许的目录里跑，
// 二是排查"某个路径写不进去"时不必改代码。
func localDBPath() (string, error) {
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
	return filepath.Join(dir, "kustos.db"), nil
}
