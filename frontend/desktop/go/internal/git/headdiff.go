package git

import (
	"errors"
	"os"
	"strings"
)

// HeadDiff 返回文件相对 HEAD 的 unified diff 文本。
//
// Args:
//
//	dir:  仓库目录
//	path: 相对仓库根的路径
//
// Returns:
//
//	统一 diff 文本；路径为空、仓库不可访问时返回错误。
//
// 对比基准是 **HEAD**，而不是 FileDiff(staged=false) 用的索引：编辑器里的
// 行标要回答"这份文件相对上次提交改了什么"，已暂存与未暂存都算改动。
// 用索引做基准会让暂存过的行突然"变回原样"，行标与用户记忆里的版本对不上。
//
// 未跟踪文件在 HEAD 里没有版本，与 FileDiff 一样走"与空文件比较"，
// 得到整份新增的形态——新文件的行标应该全是新增，而不是什么都没有。
func HeadDiff(dir, path string) (string, error) {
	abs, err := checkDir(dir)
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", errors.New("路径为空")
	}

	tracked, err := isTracked(abs, path)
	if err == nil && !tracked {
		// git diff 对未跟踪文件没有输出，也可能以非零码退出；
		// 只有"既报错又没有任何输出"才算真失败。
		out, diffErr := execGit(abs, "diff", "--no-index", "--", os.DevNull, path)
		if diffErr != nil && strings.TrimSpace(out) == "" {
			return "", diffErr
		}
		return out, nil
	}

	return execGit(abs, "diff", "HEAD", "--", path)
}
