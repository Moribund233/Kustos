package lsp

import (
	"os"
	"os/exec"
	"path/filepath"
)

// Language 是一种可接入的语言及其服务器。
//
// 记录的是"怎么发现"与"缺了怎么办"，不记录"装在哪里"：安装位置由用户的
// PATH 决定，机器之间不同；把它固化进代码会让自托管用户在自己的机器上
// 永远探测失败。
type Language struct {
	// ID 是稳定标识（typescript、go 这类），用于前后端对齐与去重。
	ID string
	// Server 是可执行文件名，从 PATH 里找。
	Server string
	// Markers 是判定"这个仓库属于该语言"的证据文件（相对仓库根）。
	Markers []string
	// InstallHint 是服务器缺失时给用户看的安装命令。
	//
	// 不静默下载二进制：自托管用户常在受限网络里，静默下载大概率失败且无法
	// 审计。给命令、给复制按钮，装完由用户点"重新探测"。
	InstallHint string
}

// Languages 是探测表，顺序即优先级。
//
// 顺序有讲究：TypeScript 在 JSON 之类宽松 marker 之前。一个 TS 项目往往同时
// 有 package.json 与一堆 *.json，先命中宽松的那条会让整个工作区退化成只有
// 格式校验，而用户期待的是类型信息。
var Languages = []Language{
	{
		ID:          "typescript",
		Server:      "typescript-language-server",
		Markers:     []string{"tsconfig.json", "jsconfig.json", "package.json"},
		InstallHint: "npm install -g typescript typescript-language-server",
	},
	{
		ID:          "python",
		Server:      "pyright-langserver",
		Markers:     []string{"pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"},
		InstallHint: "npm install -g pyright",
	},
	{
		ID:          "go",
		Server:      "gopls",
		Markers:     []string{"go.mod"},
		InstallHint: "go install golang.org/x/tools/gopls@latest",
	},
	{
		ID:          "rust",
		Server:      "rust-analyzer",
		Markers:     []string{"Cargo.toml"},
		InstallHint: "rustup component add rust-analyzer",
	},
}

// Detect 按 marker 文件判定仓库属于哪种语言。
//
// 只看仓库根的 marker：往深处递归会让一个 node_modules 就足以把仓库判成
// TypeScript，而工作区根的语言决定整个会话的服务器，判错等于全局失效。
//
// Args:
//
//	root: 工作副本根目录的绝对路径
//
// Returns:
//
//	命中的语言；没有任何 marker 命中时返回 false。
func Detect(root string) (Language, bool) {
	for _, lang := range Languages {
		for _, marker := range lang.Markers {
			if _, err := os.Stat(filepath.Join(root, marker)); err == nil {
				return lang, true
			}
		}
	}
	return Language{}, false
}

// Lookup 按 ID 取语言定义。
//
// Args:
//
//	id: 语言 ID（如 "go"）
//
// Returns:
//
//	语言定义；ID 未知时返回 false。
func Lookup(id string) (Language, bool) {
	for _, lang := range Languages {
		if lang.ID == id {
			return lang, true
		}
	}
	return Language{}, false
}

// Resolve 在 PATH 里找服务器可执行文件。
//
// Returns:
//
//	可执行文件绝对路径；未安装时返回 false（**不是错误**：没装服务器是常见
//	状态，调用方要据此降级成"仅高亮"并给出安装命令）。
func (l Language) Resolve() (string, bool) {
	if l.Server == "" {
		return "", false
	}
	path, err := exec.LookPath(l.Server)
	if err != nil {
		return "", false
	}
	return path, true
}

// Args 返回启动该服务器需要的参数。
//
// 目前都按 stdio 模式拉起：LSP 的传输由我们接管，服务器只需说协议。
// 个别服务器默认走别的传输（如 pyright 的 socket），显式给 `--stdio`
// 才不会让进程起来就退出。
func (l Language) Args() []string {
	switch l.ID {
	case "python":
		return []string{"--stdio"}
	default:
		return nil
	}
}
