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
func (s *WorkingCopyService) Remove(id string) error {
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
