package app

import (
	_ "embed"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// trayIconPNG 是托盘图标。
//
// 必须是 PNG 字节：Wails 在 Windows 上走 `w32.CreateSmallHIconFromImage`，
// 它按图片解码；塞一个 ICO 或 SVG 进去会在运行期静默失败——图标区域空白，
// 而没有任何报错。
//
//go:embed tray-icon.png
var trayIconPNG []byte

// defaultTrayLabels 是托盘菜单的默认文案。
//
// 默认中文而不是等前端下发：托盘在应用启动后就要可用，而前端的第一帧可能还在
// 恢复会话。等界面来翻译会让托盘在启动的前几百毫秒里显示空标签或英文，
// 那正是用户可以点到它的时候。前端就绪后再按当前语言覆盖一次。
type trayLabels struct {
	ShowMain string
	Review   string
	Quit     string
	Tooltip  string
}

func defaultTrayLabels() trayLabels {
	return trayLabels{
		ShowMain: "打开 Kustos",
		Review:   "评审窗",
		Quit:     "退出",
		Tooltip:  "Kustos",
	}
}

// tray 是托盘图标与菜单。
//
// 它持有菜单项的引用，因为语言切换后要就地改标签：Wails 的菜单项支持
// SetLabel，重建整个菜单会让已经展开的菜单闪一下。
type tray struct {
	mu     sync.Mutex
	labels trayLabels
	tray   *application.SystemTray
	menu   *application.Menu

	showItem *application.MenuItem
	revItem  *application.MenuItem
	quitItem *application.MenuItem

	// onShow 与 onReview 由装配层注入，托盘本身不认识窗口。
	onShow   func()
	onReview func()
	onQuit   func()
}

// newTray 构造托盘。必须在 app.Run() 之后调用 Setup，原因是 Wails 的
// SystemTray.Run 会检查应用是否已经在跑，早于它调用则托盘根本不出现。
func newTray() *tray {
	return &tray{labels: defaultTrayLabels()}
}

// wire 注入托盘菜单要触发的动作。
//
// Args:
//
//	onShow:   唤出主窗口
//	onReview: 打开（或聚焦）评审窗
//	onQuit:   真正退出应用
func (t *tray) wire(onShow, onReview, onQuit func()) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.onShow = onShow
	t.onReview = onReview
	t.onQuit = onQuit
}

// setup 创建托盘与菜单，必须紧接在 app.Run() 之后调用。
//
// Args:
//
//	app: 已启动的 Wails 应用
func (t *tray) setup(app *application.App) {
	t.mu.Lock()
	defer t.mu.Unlock()

	menu := application.NewMenu()
	t.showItem = menu.Add(t.labels.ShowMain)
	t.showItem.OnClick(func(*application.Context) {
		if t.onShow != nil {
			t.onShow()
		}
	})
	t.revItem = menu.Add(t.labels.Review)
	t.revItem.OnClick(func(*application.Context) {
		if t.onReview != nil {
			t.onReview()
		}
	})
	menu.AddSeparator()
	t.quitItem = menu.Add(t.labels.Quit)
	t.quitItem.OnClick(func(*application.Context) {
		if t.onQuit != nil {
			t.onQuit()
		}
	})

	sysTray := app.SystemTray.New()
	sysTray.SetIcon(trayIconPNG)
	sysTray.SetTooltip(t.labels.Tooltip)
	sysTray.SetMenu(menu)
	// 单击图标唤出主窗口：这是托盘应用最常用的一条路径，不该要求用户展开菜单。
	sysTray.OnClick(func() {
		if t.onShow != nil {
			t.onShow()
		}
	})
	sysTray.Run()

	t.tray = sysTray
	t.menu = menu
}

// setLabels 就地更新菜单文案。
//
// Args:
//
//	labels: 新的文案；空字段保留原值（只下发部分字段时不该把其余清空）
func (t *tray) setLabels(labels trayLabels) {
	t.mu.Lock()
	merged := t.labels
	if labels.ShowMain != "" {
		merged.ShowMain = labels.ShowMain
	}
	if labels.Review != "" {
		merged.Review = labels.Review
	}
	if labels.Quit != "" {
		merged.Quit = labels.Quit
	}
	if labels.Tooltip != "" {
		merged.Tooltip = labels.Tooltip
	}
	t.labels = merged

	show, rev, quit := t.showItem, t.revItem, t.quitItem
	sysTray := t.tray
	t.mu.Unlock()

	if show != nil {
		show.SetLabel(merged.ShowMain)
	}
	if rev != nil {
		rev.SetLabel(merged.Review)
	}
	if quit != nil {
		quit.SetLabel(merged.Quit)
	}
	if sysTray != nil {
		sysTray.SetTooltip(merged.Tooltip)
	}
}

// labelsSnapshot 返回当前文案，供测试与诊断使用。
func (t *tray) labelsSnapshot() trayLabels {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.labels
}
