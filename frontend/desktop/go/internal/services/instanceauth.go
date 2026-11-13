package services

import (
	"strings"
	"sync"

	"github.com/kustos/kustos-desktop/internal/git"
)

// 这个文件回答一个问题：**此刻这台机器登录着哪个实例**。
//
// clone / push / fetch 三条联网链路要的是同一份答案，所以凭据类型、provider
// 与取用路径都收在这里，而不是各自维护一份形状相同的结构——两份迟早漂移。
//
// 类型直接复用 git 侧的定义：git 层需要它来决定"这条命令的远端属不属于
// 本实例、该不该注入令牌"，服务层则负责把它取出来传下去。

// InstanceAuth 是向本实例发起联网 git 操作所需的凭据。
//
// 它是"这一刻"的快照，由装配层从会话服务现取：一次操作可能跑几分钟，
// 期间用户可能切换实例或退出登录，那不该让一次还在传对象的操作中途换身份，
// 也不该让它拿着一枚早已过期的令牌。
type InstanceAuth = git.InstanceAuth

// instanceAuthProvider 返回当前实例的凭据；未连接或未登录时返回零值。
var instanceAuthProvider func() InstanceAuth

// instanceAuthMu 保护 provider 的接线与读取。
var instanceAuthMu sync.RWMutex

// BindInstanceAuth 接上"当前实例凭据"的来源。
//
// 用包级绑定而不是服务方法：绑定生成器会把服务上所有导出方法变成前端可调用
// 的接口，接线动作一旦是方法，前端就能把凭据换成任意值、或让某条命令去访问
// 一个它不该访问的实例。
func BindInstanceAuth(provider func() InstanceAuth) {
	instanceAuthMu.Lock()
	defer instanceAuthMu.Unlock()
	instanceAuthProvider = provider
}

// currentInstanceAuth 返回已接上的凭据来源结果；没接线时是零值。
func currentInstanceAuth() InstanceAuth {
	instanceAuthMu.RLock()
	provider := instanceAuthProvider
	instanceAuthMu.RUnlock()
	if provider == nil {
		return InstanceAuth{}
	}
	return provider()
}

// networkAuth 返回联网 git 命令该带的凭据；不该注入时为 nil。
//
// 令牌**现取**而不是缓存：一次 push 之前它可能已经被刷新过。BaseURL 或令牌
// 为空（未连接、未登录）一律返回 nil——半个凭据只会让 git 迷惑，而且等于
// 对着远端发一枚注定失败的 Authorization 头。
//
// 这里不判断"这个工作副本属不属于本实例"：那个判断要读工作树的远端地址，
// 归 git 层（networkCredentials）做；服务层只负责把"我是谁"传下去。
func (s *WorkingCopyService) networkAuth() *InstanceAuth {
	auth := currentInstanceAuth()
	if strings.TrimSpace(auth.BaseURL) == "" || strings.TrimSpace(auth.Token) == "" {
		return nil
	}
	return &auth
}
