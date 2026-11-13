package services

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"github.com/kustos/kustos-desktop/internal/git"
	"github.com/kustos/kustos-desktop/internal/store"
)

// CloneTarget 描述一次克隆的来源与去处。
//
// 两个来源二选一：
//   - RepoPath 非空：克隆当前实例上的仓库，凭据由桌面端注入；
//   - URL 非空：克隆任意 git 地址，凭据完全交给用户自己的 git 配置。
type CloneTarget struct {
	// RepoPath 是实例上的 owner/repo（不含 .git）。前端只传这个，
	// 地址拼接在 Go 侧做，免得前端能拼出指向别处的地址。
	RepoPath string `json:"repoPath"`
	// URL 是任意外部 git 地址（https 或 scp 形式的 ssh）。
	URL string `json:"url"`
	// Branch 为空时用远端默认分支。
	Branch string `json:"branch"`
	// Dir 是目标目录的绝对路径；必须不存在。
	Dir string `json:"dir"`
}

// CloneProgressEvent 是一次克隆进度事件。
//
// 事件而不是返回值：clone 可能跑几分钟，前端要把进度画在界面上，
// 而 Wails 的一次调用只在结束时返回。
type CloneProgressEvent struct {
	// Dir 是目标目录，用来让前端确认这条进度属于自己发起的克隆。
	Dir string `json:"dir"`
	// Phase 是当前阶段。
	Phase git.ClonePhase `json:"phase"`
	// Percent 是当前阶段百分比；-1 表示该阶段没有百分比。
	Percent int `json:"percent"`
}

// errCloneInProgress 表示同一个目标目录上已有一次克隆没结束。
var errCloneInProgress = errors.New("这个目录上已经有克隆在进行")

// cloneProgressSink 把进度发到界面；未接线时静默丢弃。
var (
	cloneSinkMu sync.RWMutex
	cloneSink   func(CloneProgressEvent)
)

// BindCloneProgress 接上进度事件的出口。
//
// 用包级绑定而不是直接在服务里发 Wails 事件：服务层不该知道界面怎么收，
// 也便于测试时换成收集切片。
func BindCloneProgress(sink func(CloneProgressEvent)) {
	cloneSinkMu.Lock()
	defer cloneSinkMu.Unlock()
	cloneSink = sink
}

// emitCloneProgress 把进度送出去；没有订阅者就丢掉。
func emitCloneProgress(ev CloneProgressEvent) {
	cloneSinkMu.RLock()
	sink := cloneSink
	cloneSinkMu.RUnlock()
	if sink != nil {
		sink(ev)
	}
}

/* ------------------------------------------------------------------ */
/* 克隆                                                                */
/* ------------------------------------------------------------------ */

// CloneRemote 把仓库克隆到本地并登记为工作副本。
//
// 为什么单独一条而不是复用 Add：Add 只接受"已经存在的仓库目录"，而克隆要
// 先把目录建出来。用户的心智是"从实例拿一个仓库到本机"，中间那一步不该
// 让他先去终端敲 git clone 再回来加路径。
//
// 凭据处理分两种：
//   - 本实例仓库：用内存里的 access token，经 `GIT_CONFIG_*` 环境变量以
//     Authorization 头交给 git，**不拼进 URL、不写进 .git/config**；
//   - 外部地址：不注入任何凭据，沿用用户自己的 SSH agent / git 配置。
//
// 目标目录必须由用户明确给出：桌面端不替他挑位置。曾经默认放到 `~/Kustos`，
// 结果在"主目录在系统盘"或"安全软件拦住普通进程建目录"的机器上一点克隆就
// 吃权限错误——承担一个它无法判断的磁盘决策，还不如让用户只说一次。
//
// Args:
//
//	target: 来源（RepoPath 或 URL）与目标目录
//
// Returns:
//
//	登记好的工作副本；目录已存在、参数非法、git 失败或用户取消时返回错误。
//	取消返回的是 context.Canceled，且不会留下半成品目录。
func (s *WorkingCopyService) CloneRemote(target CloneTarget) (store.WorkingCopy, error) {
	req, cred, err := s.cloneRequest(target)
	if err != nil {
		return store.WorkingCopy{}, err
	}

	dir := strings.TrimSpace(target.Dir)
	abs, err := filepath.Abs(dir)
	if err != nil {
		return store.WorkingCopy{}, fmt.Errorf("解析目标目录失败: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	if err := s.registerClone(abs, cancel); err != nil {
		cancel()
		return store.WorkingCopy{}, err
	}
	defer func() {
		s.unregisterClone(abs)
		cancel()
	}()

	progress := func(p git.CloneProgress) {
		emitCloneProgress(CloneProgressEvent{Dir: abs, Phase: p.Phase, Percent: p.Percent})
	}

	if err := git.Clone(ctx, req, cred, progress); err != nil {
		return store.WorkingCopy{}, err
	}

	// clone 完成后走 Add 的登记逻辑：它已经处理了归一化到仓库根、
	// 重复添加复用原记录、快照回查这几件事，另写一份只会漂移。
	return s.Add(abs)
}

// cloneRequest 由来源算出真正的 git 参数与凭据。
func (s *WorkingCopyService) cloneRequest(target CloneTarget) (git.CloneRequest, *git.Credentials, error) {
	dir := strings.TrimSpace(target.Dir)
	if dir == "" {
		return git.CloneRequest{}, nil, errors.New("目标目录为空")
	}

	repoPath := strings.TrimSpace(target.RepoPath)
	rawURL := strings.TrimSpace(target.URL)
	if repoPath != "" && rawURL != "" {
		return git.CloneRequest{}, nil, errors.New("仓库路径与外部地址只能二选一")
	}
	if repoPath == "" && rawURL == "" {
		return git.CloneRequest{}, nil, errors.New("缺少克隆来源")
	}

	if repoPath != "" {
		auth := currentInstanceAuth()
		if strings.TrimSpace(auth.BaseURL) == "" {
			return git.CloneRequest{}, nil, errors.New("尚未连接实例")
		}
		if strings.TrimSpace(auth.Token) == "" {
			return git.CloneRequest{}, nil, errors.New("登录已失效，请重新登录")
		}
		cloneURL, err := git.InstanceCloneURL(auth.BaseURL, repoPath)
		if err != nil {
			return git.CloneRequest{}, nil, err
		}
		return git.CloneRequest{URL: cloneURL, Dir: dir, Branch: target.Branch},
			&git.Credentials{
				Token: auth.Token,
				URL:   cloneURL,
			}, nil
	}

	if err := git.ValidateRemoteURL(rawURL); err != nil {
		return git.CloneRequest{}, nil, err
	}
	// 外部地址不注入凭据：那条链路该由用户自己的 git 配置负责，
	// 替他决定反而可能把令牌递给第三方主机。
	return git.CloneRequest{URL: rawURL, Dir: dir, Branch: target.Branch}, nil, nil
}

// CancelClone 取消目标目录上正在进行的克隆。
//
// Args:
//
//	dir: 目标目录（与 CloneRemote 传入的一致）
//
// Returns:
//
//	没有正在进行的克隆时返回错误，让界面能区分"点了但没反应"。
func (s *WorkingCopyService) CancelClone(dir string) error {
	abs, err := filepath.Abs(strings.TrimSpace(dir))
	if err != nil {
		return fmt.Errorf("解析目标目录失败: %w", err)
	}

	s.clonesMu.Lock()
	cancel, ok := s.clones[abs]
	s.clonesMu.Unlock()
	if !ok {
		return errCloneNotRunning
	}
	cancel()
	return nil
}

// errCloneNotRunning 表示目标目录上没有正在进行的克隆。
var errCloneNotRunning = errors.New("没有正在进行的克隆")

// registerClone 登记一次进行中的克隆。
func (s *WorkingCopyService) registerClone(dir string, cancel context.CancelFunc) error {
	s.clonesMu.Lock()
	defer s.clonesMu.Unlock()
	if _, ok := s.clones[dir]; ok {
		return errCloneInProgress
	}
	s.clones[dir] = cancel
	return nil
}

// unregisterClone 清掉登记。
func (s *WorkingCopyService) unregisterClone(dir string) {
	s.clonesMu.Lock()
	defer s.clonesMu.Unlock()
	delete(s.clones, dir)
}
