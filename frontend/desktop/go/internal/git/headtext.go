package git

import (
	"errors"
	"strings"
)

// HeadFile 是文件在 HEAD 里的版本。
//
// 编辑器拿它和当前缓冲区在本地逐行对比，才能给出"随打字实时更新"的行标：
// diff 文本只能在缓冲区干净时对齐，用户一开始改动就错位了。
type HeadFile struct {
	// Exists 表示 HEAD 里是否有这个路径；新文件为 false。
	Exists bool `json:"exists"`
	// Text 是文件内容；Exists 为 false 时为空串。
	//
	// 行尾原样返回（Windows 上的仓库完全可能存的就是 CRLF）：在这里归一化
	// 会丢掉"磁盘上到底是哪种行尾"这个信息，交给读的一方决定怎么比。
	Text string `json:"text"`
	// Binary 表示内容含 NUL 字节，不是可逐行比较的文本。
	//
	// 单独标出来而不是让调用方自己扫：前端要在渲染前就跳过行标，
	// 把一段二进制塞进逐行 diff 只会得到满屏乱码和无意义的标记。
	Binary bool `json:"binary"`
}

// HeadText 返回文件在 HEAD 里的内容。
//
// Args:
//
//	dir:  仓库目录
//	path: 相对仓库根的路径
//
// Returns:
//
//	HEAD 里的版本；HEAD 中没有这个路径时 Exists 为 false 且不报错。
//
// 用 `git show HEAD:<path>` 而不是 checkout 后再读：只读对象库，不动工作树、
// 不碰暂存区，也就不会干扰用户正在进行的编辑。路径必须拼在 `HEAD:` 后面，
// 不能用 `--` 分隔——那样成了 pathspec，读不出内容。
//
// 未跟踪文件、刚 add 还没提交的文件、空仓库都在 HEAD 里查不到，这是编辑
// 过程中的常态，因此返回 Exists=false 而不是错误；只有路径为空或目录不可
// 访问才报错。
func HeadText(dir, path string) (HeadFile, error) {
	abs, err := checkDir(dir)
	if err != nil {
		return HeadFile{}, err
	}
	if strings.TrimSpace(path) == "" {
		return HeadFile{}, errors.New("路径为空")
	}

	// `git show` 失败时 stdout 为空，正好可以统一按"HEAD 里没有"处理：
	// 路径不存在、已被删除、仓库还没有提交，对调用方都是同一种情形。
	out, err := execGit(abs, "show", "HEAD:"+path)
	if err != nil {
		return HeadFile{Exists: false}, nil
	}

	return HeadFile{
		Exists: true,
		Text:   out,
		Binary: strings.IndexByte(out, 0) >= 0,
	}, nil
}
