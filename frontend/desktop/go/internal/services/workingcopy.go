package services

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/kustos/kustos-desktop/internal/git"
	"github.com/kustos/kustos-desktop/internal/platform/shellopen"
	"github.com/kustos/kustos-desktop/internal/store"
)

// WorkingCopyService 是本地 Git 的唯一入口。
//
// 边界与 SessionService 一致：它只回答"本机工作树是什么状态"。
// **不做权限判断、不做合并策略**——"这个用户能不能 push 到这个分支"
// 必须回服务端裁决（`app/core/permissions.py` 是唯一裁决点）。
//
// 所有 git 调用都走系统 git 可执行文件：hooks、LFS、签名、用户的 gitconfig
// 都是坑，桌面端的价值是"和终端里行为一致"，不是提供一个略异的替代实现。
type WorkingCopyService struct {
	store *store.DB

	// mu 保护 pathLocks 的登记。
	mu sync.Mutex
	// pathLocks 给每个工作树一把锁：同一个仓库不能同时跑两条 git 命令。
	// git 自己会用 index.lock 拒绝并发，但那会让用户看到 "index.lock exists"
	// 这种内部错误；在进程内串行化能把它变成"稍等一下"。
	pathLocks map[string]*sync.Mutex
}

// NewWorkingCopyService 构造工作副本服务。
func NewWorkingCopyService(db *store.DB) *WorkingCopyService {
	return &WorkingCopyService{store: db, pathLocks: make(map[string]*sync.Mutex)}
}

// lockFor 返回某个工作树的锁。
func (s *WorkingCopyService) lockFor(path string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	if l, ok := s.pathLocks[path]; ok {
		return l
	}
	l := &sync.Mutex{}
	s.pathLocks[path] = l
	return l
}

/* ------------------------------------------------------------------ */
/* 添加与列出                                                          */
/* ------------------------------------------------------------------ */

// Add 把一个本地仓库加入工作副本列表。
//
// Args:
//
//	path: 仓库目录（可以是仓库内任意子目录，会归一化到仓库根）
//
// Returns:
//
//	记录下来的工作副本；路径不是仓库、不可访问或写库失败时返回错误。
//
// 重复添加同一路径会复用原记录：用户不该在列表里看到两个相同条目。
func (s *WorkingCopyService) Add(path string) (store.WorkingCopy, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return store.WorkingCopy{}, errors.New("路径为空")
	}

	ok, err := git.IsRepository(trimmed)
	if err != nil {
		return store.WorkingCopy{}, err
	}
	if !ok {
		return store.WorkingCopy{}, fmt.Errorf("不是 git 仓库: %s", trimmed)
	}

	// 归一化到仓库根：用户可能选的是子目录，后续 status/diff 的路径
	// 都以仓库根为基准，记错了基准会让所有路径对不上。
	root, err := git.Root(trimmed)
	if err != nil {
		return store.WorkingCopy{}, err
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return store.WorkingCopy{}, fmt.Errorf("解析仓库路径失败: %w", err)
	}

	branch, _ := git.CurrentBranch(abs)
	ahead, behind, _ := git.AheadBehind(abs)
	status, statusErr := git.RepoStatus(abs)

	wc := store.WorkingCopy{
		ID:         workingCopyID(abs),
		Path:       abs,
		Branch:     branch,
		Ahead:      ahead,
		Behind:     behind,
		LastScanAt: time.Now().Unix(),
	}
	if statusErr == nil {
		wc.Dirty = status.Dirty
	}

	if err := s.store.SaveWorkingCopy(wc); err != nil {
		return store.WorkingCopy{}, err
	}

	// 回查库里真正生效的那一行：SaveWorkingCopy 按 path upsert 会保留原有 id，
	// 此时上面算出的 id 未必等于库里那一行的 id，拿它当返回值会让前端
	// 后续调用 Status(id) 全部失败。
	persisted, found, err := s.store.GetWorkingCopyByPath(abs)
	if err != nil || !found {
		return wc, nil
	}
	return persisted, nil
}

// workingCopyID 由绝对路径派生稳定 ID。
//
// 用路径而不是随机 UUID：同一目录重复添加要命中同一行。
// 用 SHA-256 而不是截断原文：路径长度不定，且可能含分隔符。
func workingCopyID(absPath string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(absPath)))
	return base64.RawURLEncoding.EncodeToString(sum[:12])
}

// List 返回已登记的工作副本。
func (s *WorkingCopyService) List() ([]store.WorkingCopy, error) {
	return s.store.ListWorkingCopies()
}

// Remove 从列表移除工作副本记录。
//
// **不删除磁盘上的工作树**：用户不期望"从列表移除"等于删掉目录。
// 未保存的 buffer 一并清掉：它们永远等不到对应的仓库，留着只会在
// 下次启动时冒出一批无法恢复的条目。
func (s *WorkingCopyService) Remove(id string) error {
	if err := s.store.ClearBufferRecoveriesFor(id); err != nil {
		return err
	}
	return s.store.DeleteWorkingCopy(id)
}

// get 按 id 取工作副本，并校验工作树仍然存在。
func (s *WorkingCopyService) get(id string) (store.WorkingCopy, error) {
	wc, ok, err := s.store.GetWorkingCopy(id)
	if err != nil {
		return store.WorkingCopy{}, err
	}
	if !ok {
		return store.WorkingCopy{}, fmt.Errorf("工作副本不存在: %s", id)
	}
	// 工作树被用户在终端里删掉是常见情况（重装、清理磁盘）。
	// 这里明确报错，而不是让 git 返回一句 "not a git repository"。
	if _, statErr := os.Stat(wc.Path); statErr != nil {
		return store.WorkingCopy{}, fmt.Errorf("工作树已不存在: %s", wc.Path)
	}
	return wc, nil
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

// StatusResult 是工作区扫描结果（对前端绑定友好，字段扁平）。
type StatusResult struct {
	Branch  string       `json:"branch"`
	Dirty   bool         `json:"dirty"`
	Ahead   int          `json:"ahead"`
	Behind  int          `json:"behind"`
	Changes []git.Change `json:"changes"`
}

// Status 扫描工作区并把快照写回本地库。
//
// Args:
//
//	id: 工作副本 ID
//
// Returns:
//
//	当前分支、是否有改动、领先/落后、变更列表。
//
// 快照写回是必要的：列表页要能直接显示"脏/干净"。否则每次渲染都得为
// 每个仓库跑一次 git status，在大会话里那会是几百毫秒的卡顿。
func (s *WorkingCopyService) Status(id string) (StatusResult, error) {
	wc, err := s.get(id)
	if err != nil {
		return StatusResult{}, err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	st, err := git.RepoStatus(wc.Path)
	if err != nil {
		return StatusResult{}, err
	}

	ahead, behind, _ := git.AheadBehind(wc.Path)

	// 快照更新失败不该让界面拿不到状态：状态本身是对的，
	// 只是下次打开列表时显示的脏标记可能旧一点。
	wc.Branch = st.Branch
	wc.Dirty = st.Dirty
	wc.Ahead = ahead
	wc.Behind = behind
	wc.LastScanAt = time.Now().Unix()
	_ = s.store.SaveWorkingCopy(wc)

	return StatusResult{
		Branch:  st.Branch,
		Dirty:   st.Dirty,
		Ahead:   ahead,
		Behind:  behind,
		Changes: st.Changes,
	}, nil
}

/* ------------------------------------------------------------------ */
/* 暂存与提交                                                          */
/* ------------------------------------------------------------------ */

// Stage 把指定路径加入暂存区。
func (s *WorkingCopyService) Stage(id string, paths []string) error {
	wc, err := s.get(id)
	if err != nil {
		return err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	return git.Stage(wc.Path, paths)
}

// Unstage 把指定路径移出暂存区（保留工作区改动）。
func (s *WorkingCopyService) Unstage(id string, paths []string) error {
	wc, err := s.get(id)
	if err != nil {
		return err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	return git.Unstage(wc.Path, paths)
}

// StageHunk 把某文件中指定的一个 hunk 暂存。
//
// Args:
//
//	id:     工作副本 ID
//	path:   相对仓库根的路径
//	header: 界面里的 hunk 头原文，例如 `@@ -112,7 +112,9 @@`
//
// 与 Stage 共用同一把工作树锁：逐块暂存会连续改 index，与整文件暂存或提交
// 并发时 git 会报 `index.lock exists`，用户看到的是"点一下没反应"。
func (s *WorkingCopyService) StageHunk(id, path, header string) error {
	wc, err := s.get(id)
	if err != nil {
		return err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	return git.StageHunk(wc.Path, path, header)
}

// UnstageHunk 把暂存区里指定的一个 hunk 撤回工作区侧（不丢弃改动）。
func (s *WorkingCopyService) UnstageHunk(id, path, header string) error {
	wc, err := s.get(id)
	if err != nil {
		return err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	return git.UnstageHunk(wc.Path, path, header)
}

// Commit 提交暂存区内容。
//
// Args:
//
//	id:      工作副本 ID
//	message: 提交信息（不能为空）
//	amend:   是否修补上一次提交
func (s *WorkingCopyService) Commit(id, message string, amend bool) error {
	wc, err := s.get(id)
	if err != nil {
		return err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	if err := git.Commit(wc.Path, message, amend); err != nil {
		return err
	}

	// 提交后刷新快照：列表页要立刻反映"已干净"。
	if st, err := git.RepoStatus(wc.Path); err == nil {
		ahead, behind, _ := git.AheadBehind(wc.Path)
		wc.Branch = st.Branch
		wc.Dirty = st.Dirty
		wc.Ahead = ahead
		wc.Behind = behind
		wc.LastScanAt = time.Now().Unix()
		_ = s.store.SaveWorkingCopy(wc)
	}
	return nil
}

/* ------------------------------------------------------------------ */
/* diff 与分支                                                         */
/* ------------------------------------------------------------------ */

// FileDiff 返回单个文件的 diff。
//
// Args:
//
//	id:     工作副本 ID
//	path:   相对仓库根的路径
//	staged: true 读暂存区，false 读工作区
//
// 未提交的 diff 全部在本地算，不走网络：这是桌面端相对 Web 的核心优势，
// 断网时也能看自己改了什么。
func (s *WorkingCopyService) FileDiff(id, path string, staged bool) (string, error) {
	wc, err := s.get(id)
	if err != nil {
		return "", err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	return git.FileDiff(wc.Path, path, staged)
}

// HeadDiff 返回文件相对 HEAD 的 diff。
//
// Args:
//
//	id:   工作副本 ID
//	path: 相对仓库根的路径
//
// 与 FileDiff 的 staged=false 不同：基准是 HEAD 而不是索引，因此已暂存与
// 未暂存的改动都会出现在结果里。编辑器用它在行号旁标记"相对上次提交的增删"，
// 用户的心智基准是那次提交，而不是他刚才 stage 过什么。
//
// 与所有未提交 diff 一样在本地算，不走网络。
func (s *WorkingCopyService) HeadDiff(id, path string) (string, error) {
	wc, err := s.get(id)
	if err != nil {
		return "", err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	return git.HeadDiff(wc.Path, path)
}

// HeadText 返回文件在 HEAD 里的完整内容。
//
// Args:
//
//	id:   工作副本 ID
//	path: 相对仓库根的路径
//
// 与 HeadDiff 返回 diff 不同，这里给的是原文：编辑器要把它和**当前缓冲区**
// （可能已改、甚至还没保存）逐行对比，才能随着打字实时给出行标。文本 diff
// 只能在缓冲区干净时对齐，用户一动键盘标记就整体错位。
//
// HEAD 里没有这个路径时返回 Exists=false 且不报错：新文件在编辑中是常态。
func (s *WorkingCopyService) HeadText(id, path string) (git.HeadFile, error) {
	wc, err := s.get(id)
	if err != nil {
		return git.HeadFile{}, err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	return git.HeadText(wc.Path, path)
}

// FileBlame 返回文件每一行的归属提交。
//
// Args:
//
//	id:   工作副本 ID
//	path: 相对仓库根的路径
//
// Returns:
//
//	按行号升序的归属列表；文件不在 HEAD 里时返回空列表而不是错误。
//
// blame 只读本地对象库，不走网络：断网时也能看到"这行是谁写的"。
func (s *WorkingCopyService) FileBlame(id, path string) ([]git.BlameLine, error) {
	wc, err := s.get(id)
	if err != nil {
		return nil, err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	return git.Blame(wc.Path, path)
}

// Branches 列出本地分支。
func (s *WorkingCopyService) Branches(id string) ([]git.Branch, error) {
	wc, err := s.get(id)
	if err != nil {
		return nil, err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	return git.Branches(wc.Path)
}

/* ------------------------------------------------------------------ */
/* 远端同步                                                            */
/* ------------------------------------------------------------------ */

// Push 把当前分支推送到上游。
//
// Args:
//
//	id:    工作副本 ID
//	force: 是否强制推送
//
// Returns:
//
//	失败时返回可读错误。凭证走系统 git 的 credential helper / SSH agent——
//	桌面端不接触也不存储远端密码，那是用户机器上已经配好的东西。
//
// 推送是长任务，因此单独走网络超时，不受本地命令那 30 秒的限制。
func (s *WorkingCopyService) Push(id string, force bool) error {
	wc, err := s.get(id)
	if err != nil {
		return err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	if err := git.Push(wc.Path, force); err != nil {
		return err
	}

	// 推送后刷新快照：状态条要立刻反映"已同步"。
	s.refreshSnapshot(wc)
	return nil
}

// PushCommand 返回将要执行的 push 命令。
//
// 破坏性操作（尤其是强制推送）必须在确认框里显示完整命令：
// "确认强制推送？"无法让人判断后果，`git push --force-with-lease` 可以。
func (s *WorkingCopyService) PushCommand(id string, force bool) (string, error) {
	wc, err := s.get(id)
	if err != nil {
		return "", err
	}
	return git.PushCommand(wc.Path, force), nil
}

// Fetch 从上游拉取引用（不改工作区）。
func (s *WorkingCopyService) Fetch(id string) error {
	wc, err := s.get(id)
	if err != nil {
		return err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	if err := git.Fetch(wc.Path); err != nil {
		return err
	}
	s.refreshSnapshot(wc)
	return nil
}

// refreshSnapshot 重新扫描并写回快照；失败静默。
//
// 快照只是为了列表页不用逐仓库跑 git status，写不进去不该影响用户
// 刚刚成功完成的操作。
func (s *WorkingCopyService) refreshSnapshot(wc store.WorkingCopy) {
	st, err := git.RepoStatus(wc.Path)
	if err != nil {
		return
	}
	ahead, behind, _ := git.AheadBehind(wc.Path)
	wc.Branch = st.Branch
	wc.Dirty = st.Dirty
	wc.Ahead = ahead
	wc.Behind = behind
	wc.LastScanAt = time.Now().Unix()
	_ = s.store.SaveWorkingCopy(wc)
}

/* ------------------------------------------------------------------ */
/* 系统集成                                                            */
/* ------------------------------------------------------------------ */

// RemoteInfo 返回当前分支上游远端的名字与地址。
//
// 前端据此把"本机这个目录"关联到服务端的仓库记录：remote 地址里的
// `owner/repo` 片段是两者之间唯一可靠的桥梁。关联完之后 PR 与 Issue 面
// 才知道该向服务端要哪个仓库的数据。
//
// Args:
//
//	id: 工作副本 ID
//
// Returns:
//
//	远端名与地址；仓库还没接远端时两者皆为空字符串。
func (s *WorkingCopyService) RemoteInfo(id string) (git.Upstream, error) {
	wc, err := s.get(id)
	if err != nil {
		return git.Upstream{}, err
	}

	lock := s.lockFor(wc.Path)
	lock.Lock()
	defer lock.Unlock()

	return git.RemoteInfo(wc.Path), nil
}

// OpenInEditor 在用户配置的编辑器中打开仓库内的文件。
//
// Args:
//
//	id:   工作副本 ID
//	path: 相对仓库根的路径
//
// Returns:
//
//	路径越界、文件不存在或无法启动编辑器时返回错误。
//
// 路径必须先收敛到仓库根之内：这是前端传来的字符串，若直接拼进
// filepath.Join，`../../../etc/passwd` 会打开仓库外的文件。
func (s *WorkingCopyService) OpenInEditor(id, path string) error {
	wc, err := s.get(id)
	if err != nil {
		return err
	}

	abs, err := resolveInside(wc.Path, path, false)
	if err != nil {
		return err
	}

	// 编辑器是长期进程，不该在 git 锁内启动。
	return shellopen.OpenInEditor(abs)
}

// RevealInFileManager 在系统文件管理器里定位仓库内的文件。
func (s *WorkingCopyService) RevealInFileManager(id, path string) error {
	wc, err := s.get(id)
	if err != nil {
		return err
	}

	abs, err := resolveInside(wc.Path, path, false)
	if err != nil {
		return err
	}
	return shellopen.Reveal(abs)
}

// resolveInside 把相对路径收敛到 root 之内，并确认目标存在。
//
// Returns:
//
//	绝对路径；路径为空、越界或不存在时返回错误。
//
// 越界判定用"收敛后的绝对路径是否仍以 root 为前缀"，而不是检查字符串里
// 有没有 `..`——`a/../b` 这种写法合法但含 `..`，而软链接也可能把路径
// 指向仓库外。
func resolveInside(root, rel string, allowRoot bool) (string, error) {
	trimmed := strings.TrimSpace(rel)
	if trimmed == "" {
		// 空路径表示仓库根本身：只有"列举根目录"这种场景才允许。
		if !allowRoot {
			return "", errors.New("路径为空")
		}
		abs, err := filepath.Abs(root)
		if err != nil {
			return "", fmt.Errorf("解析仓库路径失败: %w", err)
		}
		return abs, nil
	}
	// 绝对路径一律拒绝：前端只应传相对仓库根的路径。
	if filepath.IsAbs(trimmed) || strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, "\\") {
		return "", fmt.Errorf("只接受仓库内的相对路径: %s", rel)
	}

	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("解析仓库路径失败: %w", err)
	}
	target, err := filepath.Abs(filepath.Join(rootAbs, filepath.FromSlash(trimmed)))
	if err != nil {
		return "", fmt.Errorf("解析目标路径失败: %w", err)
	}

	// 收敛软链接后再比一次，防止仓库内的软链指向仓库外。
	realRoot, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		realRoot = rootAbs
	}
	if targetReal, err := filepath.EvalSymlinks(target); err == nil {
		target = targetReal
	}

	if !isWithin(realRoot, target) {
		return "", fmt.Errorf("路径超出仓库范围: %s", rel)
	}

	if _, statErr := os.Stat(target); statErr != nil {
		return "", fmt.Errorf("%w: %s", ErrPathNotFound, rel)
	}
	return target, nil
}

// ErrPathNotFound 表示路径收敛在仓库内，但目标不存在。
//
// 单独定义而不是靠错误文案判断：调用方需要区分"越界（拒绝）"与
// "文件没了（正常情形）"，比对中文错误串会在措辞调整时静默失效。
var ErrPathNotFound = errors.New("路径不存在")

// isWithin 判断 target 是否位于 root 之内（含 root 本身）。
func isWithin(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	// ".." 开头表示跑到了 root 之外；"." 表示就是 root 本身。
	return rel == "." || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))
}
