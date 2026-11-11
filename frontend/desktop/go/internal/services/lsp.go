package services

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/kustos/kustos-desktop/internal/lsp"
	"github.com/kustos/kustos-desktop/internal/store"
)

// ErrWorkspaceUntrusted 表示工作区还没被用户信任，不允许启动语言服务器。
var ErrWorkspaceUntrusted = errors.New("工作区尚未被信任，不能运行本地语言服务器")

// normalizeRoot 把工作区路径收敛成同一形式。
//
// 信任记录按路径存，而路径会被用户手输、被 git 输出回填、被界面从别处传回：
// 不收敛就会出现"明明刚点过信任，下一次又弹确认"。
func normalizeRoot(root string) (string, error) {
	if strings.TrimSpace(root) == "" {
		return "", errors.New("工作区路径不能为空")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("工作区路径无法解析: %w", err)
	}
	return filepath.Clean(abs), nil
}

// AuthorizeWorkspace 判断某个工作区是否允许运行语言服务器。
//
// **必须是包级函数而不是服务方法**：Wails 的绑定生成器会把服务上所有导出方法
// 变成前端可调用的接口，而这个判断只该由 Go 侧的 `/lsp/` 处理器调用。
//
// 只查信任记录，不查"是不是我们的工作副本"：能打开编辑器的目录都已经通过了
// 工作副本校验，这里再查一次只会让两条路径的判定逐渐漂开。
func AuthorizeWorkspace(db *store.DB, root string) error {
	normalized, err := normalizeRoot(root)
	if err != nil {
		return err
	}
	trust, ok, err := db.GetWorkspaceTrust(normalized)
	if err != nil {
		return err
	}
	if !ok {
		return ErrWorkspaceUntrusted
	}
	if !trust.Trusted {
		return ErrWorkspaceUntrusted
	}
	return nil
}

// LanguageHint 是一种语言及其语言服务器的安装状态。
type LanguageHint struct {
	// ID 是语言标识（typescript / python / go / rust）。
	ID string `json:"id"`
	// Server 是语言服务器的可执行文件名。
	Server string `json:"server"`
	// Installed 表示这台机器上现在找不找得到它。
	Installed bool `json:"installed"`
	// InstallHint 是安装命令，原样给用户复制。
	InstallHint string `json:"installHint"`
}

// TrustState 是一个工作区的信任状态。
type TrustState struct {
	// Path 是收敛后的工作区绝对路径。
	Path string `json:"path"`
	// Trusted 表示用户已允许在该目录运行语言服务器。
	Trusted bool `json:"trusted"`
	// Decided 区分"问过并拒绝"与"还没问过"。
	Decided bool `json:"decided"`
}

// DetectedLanguage 是按工作区里的 marker 探测出的语言。
//
// 字段摊平而不是嵌一个 LanguageHint：绑定生成器会把这里原样变成 TS 类型，
// 多一层嵌套只是让前端的取值路径更长。
type DetectedLanguage struct {
	// Found 表示工作区里有认得的 marker。
	Found bool `json:"found"`
	// ID 是语言标识；未识别时为空。
	ID string `json:"id"`
	// Server 是这类语言要用的服务器可执行文件名。
	Server string `json:"server"`
	// Installed 表示这台机器上现在找不找得到它。
	Installed bool `json:"installed"`
	// InstallHint 是安装命令，原样给用户复制。
	InstallHint string `json:"installHint"`
}

// LSPService 把本地语言服务器的进程池与管理信息暴露给界面。
type LSPService struct {
	pool  *lsp.Pool
	store *store.DB
}

// NewLSPService 构造语言服务器服务。
//
// Args:
//
//	db:   本地库（信任记录）
//	pool: 进程池
func NewLSPService(db *store.DB, pool *lsp.Pool) *LSPService {
	return &LSPService{pool: pool, store: db}
}

// Ensure 为一个工作区准备好语言服务器。
//
// 未信任的工作区直接拒绝：语言服务器会执行工作区里的代码（解析 import、
// 加载 package.json 里的脚本、跑 go list），默认放行等于让"clone 一个仓库"
// 变成"在你机器上跑它的构建脚本"。
//
// Args:
//
//	root:     工作区根目录
//	language: 语言标识；传空串则按工作区里的 marker 探测
//
// Returns:
//
//	会话信息；未信任、服务器未安装或超出并发上限时返回错误。
func (s *LSPService) Ensure(root, language string) (lsp.Info, error) {
	normalized, err := normalizeRoot(root)
	if err != nil {
		return lsp.Info{}, err
	}
	if err := AuthorizeWorkspace(s.store, normalized); err != nil {
		return lsp.Info{}, err
	}
	return s.pool.Ensure(normalized, language)
}

// Sessions 返回当前所有语言服务器会话。
//
// Returns:
//
//	按启动时间排序的列表；没有会话时返回空切片。
func (s *LSPService) Sessions() []lsp.Info {
	return s.pool.Sessions()
}

// Restart 重启某个工作区的语言服务器。
//
// 用于"装了新版本"或"服务器卡住"这类手动恢复。
func (s *LSPService) Restart(root string) (lsp.Info, error) {
	normalized, err := normalizeRoot(root)
	if err != nil {
		return lsp.Info{}, err
	}
	if err := AuthorizeWorkspace(s.store, normalized); err != nil {
		return lsp.Info{}, err
	}
	return s.pool.Restart(normalized)
}

// Stop 停掉某个工作区的语言服务器。
func (s *LSPService) Stop(root string) error {
	normalized, err := normalizeRoot(root)
	if err != nil {
		return err
	}
	return s.pool.Stop(normalized)
}

// LanguageHints 返回探测表里每种语言的安装状态。
//
// 界面据此显示"已就绪 / 未安装 + 安装命令"。**不静默下载二进制**：
// 往用户机器上装东西必须是用户自己做的动作，这里只给命令和复制按钮。
func (s *LSPService) LanguageHints() []LanguageHint {
	languages := lsp.Languages
	hints := make([]LanguageHint, 0, len(languages))
	for _, lang := range languages {
		_, installed := lang.Resolve()
		hints = append(hints, LanguageHint{
			ID:          lang.ID,
			Server:      lang.Server,
			Installed:   installed,
			InstallHint: lang.InstallHint,
		})
	}
	return hints
}

// DetectLanguage 按工作区根目录里的 marker 判断该用哪种语言服务器。
//
// 与 Ensure 分开：界面要能先问"这个仓库该配什么"，再决定是否弹信任确认，
// 而 Ensure 一旦被调用就意味着"准备开跑"。
func (s *LSPService) DetectLanguage(root string) (DetectedLanguage, error) {
	normalized, err := normalizeRoot(root)
	if err != nil {
		return DetectedLanguage{}, err
	}
	lang, ok := lsp.Detect(normalized)
	if !ok {
		return DetectedLanguage{}, nil
	}
	_, installed := lang.Resolve()
	return DetectedLanguage{
		Found:       true,
		ID:          lang.ID,
		Server:      lang.Server,
		Installed:   installed,
		InstallHint: lang.InstallHint,
	}, nil
}

// TrustStatus 查询一个工作区是否已获信任。
func (s *LSPService) TrustStatus(root string) (TrustState, error) {
	normalized, err := normalizeRoot(root)
	if err != nil {
		return TrustState{}, err
	}
	trust, ok, err := s.store.GetWorkspaceTrust(normalized)
	if err != nil {
		return TrustState{}, err
	}
	return TrustState{Path: normalized, Trusted: ok && trust.Trusted, Decided: ok}, nil
}

// SetTrust 记录用户对一个工作区的信任决定。
//
// 撤销信任时顺手停掉该工作区已经跑起来的语言服务器：留着它等于"用户说不许，
// 但进程还在跑"，那比不问更糟。
//
// Args:
//
//	root:    工作区根目录
//	trusted: 是否允许运行本地语言服务器
func (s *LSPService) SetTrust(root string, trusted bool) error {
	normalized, err := normalizeRoot(root)
	if err != nil {
		return err
	}
	if err := s.store.SetWorkspaceTrust(normalized, trusted); err != nil {
		return err
	}
	if !trusted {
		// 停不掉不是错误：本来就没有会话是常态。
		_ = s.pool.Stop(normalized)
	}
	return nil
}
