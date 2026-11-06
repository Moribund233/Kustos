// Package keychain 封装 refresh token 的系统级安全存储。
//
// 浏览器只有 localStorage，XSS 即失守；桌面端的 refresh token 必须进
// OS Keychain（macOS Keychain / Windows Credential Manager / Linux Secret
// Service），并且**永不出 Go 进程**——JS 只拿到短命的 access token。
//
// 分层：
//   - keyringStore：真实系统钥匙串（生产路径）
//   - memoryStore：进程内存储（CI、无桌面会话的 Linux、以及钥匙串不可用时的降级）
//
// 为什么需要降级而不是硬失败：Linux 上没有 Secret Service（无桌面会话、
// 容器内、SSH 会话）时 keyring 会返回错误。此时让用户完全无法登录比
// "本次会话内有效、重启需重登"更糟——后者是可接受的降级，前者不是。
// 降级会显式记录，前端能看到"凭据仅本会话有效"的提示。
package keychain

import (
	"errors"
	"fmt"
	"sync"

	"github.com/zalando/go-keyring"
)

// serviceName 是钥匙串里的服务标识，与产品标识一致。
const serviceName = "com.kustos.desktop"

// Store 是凭据存储接口。
type Store interface {
	// Set 写入（或覆盖）某个键的密文。
	Set(key, secret string) error
	// Get 读取；不存在时返回 ErrNotFound。
	Get(key string) (string, error)
	// Delete 删除；不存在视为成功（幂等）。
	Delete(key string) error
	// Persistent 表示凭据是否真的落到了系统钥匙串。
	// 为 false 时（内存降级）调用方应告知用户"重启后需重新登录"。
	Persistent() bool
}

// ErrNotFound 表示凭据不存在。
var ErrNotFound = errors.New("凭据不存在")

// keyringStore 使用系统钥匙串。
type keyringStore struct{}

// NewSystemStore 返回系统钥匙串存储。
func NewSystemStore() Store { return keyringStore{} }

func (keyringStore) Set(key, secret string) error {
	if err := keyring.Set(serviceName, key, secret); err != nil {
		return fmt.Errorf("写入系统钥匙串失败: %w", err)
	}
	return nil
}

func (keyringStore) Get(key string) (string, error) {
	secret, err := keyring.Get(serviceName, key)
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("读取系统钥匙串失败: %w", err)
	}
	return secret, nil
}

func (keyringStore) Delete(key string) error {
	err := keyring.Delete(serviceName, key)
	if err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return fmt.Errorf("删除系统钥匙串条目失败: %w", err)
	}
	return nil
}

func (keyringStore) Persistent() bool { return true }

// memoryStore 是进程内存储，用于降级与测试。
type memoryStore struct {
	mu   sync.RWMutex
	data map[string]string
}

// NewMemoryStore 返回进程内存储。
func NewMemoryStore() Store {
	return &memoryStore{data: make(map[string]string)}
}

func (m *memoryStore) Set(key, secret string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = secret
	return nil
}

func (m *memoryStore) Get(key string) (string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	secret, ok := m.data[key]
	if !ok {
		return "", ErrNotFound
	}
	return secret, nil
}

func (m *memoryStore) Delete(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
	return nil
}

func (m *memoryStore) Persistent() bool { return false }

// Composite 优先用系统钥匙串，不可用时降级到内存，并记住降级状态。
//
// 探测是**惰性**的：只有真正写入失败才降级，而不是启动时猜。
// 这样在有钥匙串的机器上不会因为探测误判而降级。
type Composite struct {
	system Store
	memory Store

	mu         sync.RWMutex
	degraded   bool
	degradeErr error
}

// NewComposite 返回"系统钥匙串优先、失败降级内存"的组合存储。
func NewComposite() *Composite {
	return &Composite{system: NewSystemStore(), memory: NewMemoryStore()}
}

// NewCompositeWith 供测试注入两个实现。
func NewCompositeWith(system, memory Store) *Composite {
	return &Composite{system: system, memory: memory}
}

func (c *Composite) Set(key, secret string) error {
	if !c.isDegraded() {
		if err := c.system.Set(key, secret); err == nil {
			return nil
		} else {
			c.markDegraded(err)
		}
	}
	return c.memory.Set(key, secret)
}

func (c *Composite) Get(key string) (string, error) {
	// 降级后优先读内存：此时真正的凭据就在内存里。
	if c.isDegraded() {
		return c.memory.Get(key)
	}
	secret, err := c.system.Get(key)
	if err == nil {
		return secret, nil
	}
	if errors.Is(err, ErrNotFound) {
		return "", ErrNotFound
	}
	c.markDegraded(err)
	return c.memory.Get(key)
}

func (c *Composite) Delete(key string) error {
	// 两处都尝试清理，避免降级前后留下的副本泄漏。
	_ = c.system.Delete(key)
	return c.memory.Delete(key)
}

// Persistent 仅在未降级时为真。
func (c *Composite) Persistent() bool { return !c.isDegraded() }

// Degraded 返回是否已降级，以及降级原因。
func (c *Composite) Degraded() (bool, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.degraded, c.degradeErr
}

func (c *Composite) isDegraded() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.degraded
}

func (c *Composite) markDegraded(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.degraded {
		c.degraded = true
		c.degradeErr = err
	}
}
