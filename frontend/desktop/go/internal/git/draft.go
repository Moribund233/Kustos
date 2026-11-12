package git

import (
	"errors"
	"strconv"
	"strings"
)

// 协作草稿分支的领先计数。
//
// 进入协作会话前要回答一个问题："在线草稿是不是已经比本地新了？"。
// 答案只能从本地已有的引用算：草稿分支不在工作分支上，checkout 过去看
// 会打断用户手上的工作，所以这里只做只读的 rev-list。

// DraftBranchName 返回某分支对应的协作草稿分支名。
//
// 与网关约定一致：草稿一律落 `collab/draft-{branch}`，工作分支只在显式发布时
// 才产生提交。
func DraftBranchName(branch string) string {
	return "collab/draft-" + branch
}

// DraftAhead 返回协作草稿相对本地分支的领先提交数。
//
// 草稿分支可能只在远端跟踪引用里（别的机器保存过），因此两个候选都查：
// 先看本地 `collab/draft-{branch}`，再看 `origin/collab/draft-{branch}`。
// 两者都不存在时返回 0 而不是错误：没保存过草稿是常态，不该让界面报错。
func DraftAhead(dir, branch string) (int, error) {
	abs, err := checkDir(dir)
	if err != nil {
		return 0, err
	}
	if strings.TrimSpace(branch) == "" {
		return 0, errors.New("空分支名")
	}

	name := DraftBranchName(branch)
	draft := ""
	for _, candidate := range []string{name, "origin/" + name} {
		if exists, err := refExists(abs, candidate); err == nil && exists {
			draft = candidate
			break
		}
	}
	if draft == "" {
		return 0, nil
	}

	// 基准取本地分支而不是 HEAD：用户可能停在一个游离提交上，而"本地有多新"
	// 指的是这个分支有多新。
	base := branch
	if exists, err := refExists(abs, branch); err != nil || !exists {
		base = "HEAD"
	}

	out, err := execGit(abs, "rev-list", "--count", base+".."+draft)
	if err != nil {
		return 0, nil
	}
	count, convErr := strconv.Atoi(strings.TrimSpace(out))
	if convErr != nil || count < 0 {
		return 0, nil
	}
	return count, nil
}

// refExists 判断某个引用能否解析成提交。
func refExists(dir, ref string) (bool, error) {
	out, err := execGit(dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(out) != "", nil
}
