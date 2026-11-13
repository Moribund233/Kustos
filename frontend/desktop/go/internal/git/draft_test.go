package git

import (
	"testing"
)

// 草稿分支的领先计数回答的是"在线是否已经比本地新"，
// 因此只做只读的引用比较，绝不 checkout。

func TestDraftBranchNameFollowsConvention(t *testing.T) {
	if got := DraftBranchName("main"); got != "collab/draft-main" {
		t.Fatalf("草稿分支名应与网关约定一致，得到 %q", got)
	}
}

// 没保存过草稿是常态：返回 0 而不是错误，界面不该为此报错。
func TestDraftAheadWithoutDraftIsZero(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	ahead, err := DraftAhead(dir, "main")
	if err != nil {
		t.Fatalf("没有草稿分支不算错误: %v", err)
	}
	if ahead != 0 {
		t.Fatalf("没有草稿分支时应为 0，实际 %d", ahead)
	}
}

func TestDraftAheadCountsNewCommits(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	// 草稿分支上两次在线保存都还没被本地看到。
	gitRun(t, dir, "checkout", "-q", "-b", DraftBranchName("main"))
	write(t, dir, "a.txt", "2\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "save 1")
	write(t, dir, "a.txt", "3\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "save 2")
	gitRun(t, dir, "checkout", "-q", "main")

	ahead, err := DraftAhead(dir, "main")
	if err != nil {
		t.Fatalf("统计草稿提交失败: %v", err)
	}
	if ahead != 2 {
		t.Fatalf("草稿应领先 2 次保存，实际 %d", ahead)
	}
}

// 草稿只在远端跟踪引用里时（别的机器保存过）也要能算出来。
func TestDraftAheadUsesRemoteTrackingRef(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	gitRun(t, dir, "checkout", "-q", "-b", "tmp")
	write(t, dir, "a.txt", "2\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "save 1")
	// 只留远端跟踪引用，模拟"别的机器保存后我 fetch 到"。
	gitRun(t, dir, "update-ref", "refs/remotes/origin/"+DraftBranchName("main"), "HEAD")
	gitRun(t, dir, "checkout", "-q", "main")
	gitRun(t, dir, "branch", "-D", "tmp")

	ahead, err := DraftAhead(dir, "main")
	if err != nil {
		t.Fatalf("统计草稿提交失败: %v", err)
	}
	if ahead != 1 {
		t.Fatalf("远端跟踪的草稿应领先 1 次保存，实际 %d", ahead)
	}
}

// 草稿在远端跟踪引用里、本地分支落后时，基准必须取同一侧。
//
// 回归：原先草稿取 origin/ 侧而基准取本地分支，把"本地落后远端"的提交也算成
// 未发布的保存。表现为发布成功后状态条仍说"还有 5 次未发布"——那 5 个提交
// 其实早就在 origin/main 里了。
func TestDraftAheadPairsRemoteDraftWithRemoteBase(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "1\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	// 远端 main 前进两次（本地不知道，也不打算 fetch 到本地分支）。
	gitRun(t, dir, "checkout", "-q", "-b", "tmp")
	write(t, dir, "a.txt", "2\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "remote 1")
	write(t, dir, "a.txt", "3\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "remote 2")
	gitRun(t, dir, "update-ref", "refs/remotes/origin/main", "HEAD")
	// 草稿就从同一个远端主分支分出去，之后才加一次保存。
	write(t, dir, "a.txt", "4\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "save 1")
	gitRun(t, dir, "update-ref", "refs/remotes/origin/"+DraftBranchName("main"), "HEAD")
	gitRun(t, dir, "checkout", "-q", "main")
	gitRun(t, dir, "branch", "-D", "tmp")

	// 本地 main 仍停在 init：只有草稿那次保存算未发布。
	ahead, err := DraftAhead(dir, "main")
	if err != nil {
		t.Fatalf("统计草稿提交失败: %v", err)
	}
	if ahead != 1 {
		t.Fatalf("基准应与草稿同取 origin 侧，只算 1 次未发布保存，实际 %d", ahead)
	}
}

func TestDraftAheadRejectsEmptyBranch(t *testing.T) {
	dir := newRepo(t)
	if _, err := DraftAhead(dir, "  "); err == nil {
		t.Fatal("空分支名应当报错")
	}
}
