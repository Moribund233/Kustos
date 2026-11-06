package services

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/kustos/kustos-desktop/internal/platform/keychain"
	"github.com/kustos/kustos-desktop/internal/store"
)

// 会话层的关键约束：
//
//   - refresh token **永不出 Go**，只进系统 Keychain；
//   - access token 交给 JS 内存，短命，与 Web 同级风险；
//   - 刷新必须**全局 single-flight**：后端 refresh 带重用检测，并发刷新会
//     吊销整个 family。Web 端多标签页各刷一次已经踩过这个坑；桌面端所有
//     窗口共享一个 Go 进程，天然只需一把锁——这是桌面架构的便宜收益。
//   - 会话失效要广播到**所有窗口**（app.Event），不只是主窗口。

// SessionService 负责实例连接、登录态与令牌刷新。
type SessionService struct {
	client   *http.Client
	store    *store.DB
	keychain *keychain.Composite

	// UpstreamSetter 把活动实例的地址同步给 bridge 的反代上游。
	//
	// 用导出字段而不是方法：绑定生成器会把所有导出方法暴露成前端 API，
	// 那等于让 JS 能改写上游地址。字段不参与绑定生成，装配层启动时赋值即可。
	UpstreamSetter func(string) error

	// mu 保护以下内存态。
	mu sync.RWMutex
	// activeInstanceID 是当前使用的实例（多实例并存是自托管产品的常态）。
	activeInstanceID string
	// accessToken 只驻内存，重启即失效（由 refresh 重新换发）。
	accessToken string
	// deviceID 是本机在该实例上的稳定标识，用于"已登录设备"里辨认。
	deviceID string

	// refreshMu 保护 inflight 的登记与清除。
	refreshMu sync.Mutex
	// inflight 是飞行中的刷新；并发调用等它而不是各发一次。
	inflight chan refreshResult
}

// 请求超时。刷新与登录都要在用户可忍受的范围内失败。
const (
	authRequestTimeout = 10 * time.Second
	// refreshLeeway 是提前刷新的余量：避免"刚好过期"的请求失败一次再重试。
	refreshLeeway = 30 * time.Second
)

// Credentials 是登录结果中返回给前端的部分。
//
// **不含 refresh token**：它只进 Keychain。这条边界写在这里而不是注释里，
// 因为它是整个桌面端安全模型的支点。
type Credentials struct {
	AccessToken string `json:"accessToken"`
	UserID      string `json:"userId"`
	Username    string `json:"username"`
	IsAdmin     bool   `json:"isAdmin"`
	// InstanceID 指明这组凭据属于哪个实例。
	InstanceID string `json:"instanceId"`
	// Persistent 表示 refresh 是否真的落进了系统钥匙串。
	// 为 false 时前端应提示"重启后需重新登录"。
	Persistent bool `json:"persistent"`
}

// LoginResult 是 AddInstance / Login 的统一返回。
type LoginResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	// ErrorCode 供前端做分支（如 invalid_credentials 提示重输密码）。
	ErrorCode string `json:"errorCode,omitempty"`
}

// NewSessionServiceWith 构造会话服务（依赖注入，便于测试）。
func NewSessionServiceWith(db *store.DB, kc *keychain.Composite) *SessionService {
	return &SessionService{
		client:   &http.Client{Timeout: authRequestTimeout},
		store:    db,
		keychain: kc,
	}
}

// syncUpstream 把实例地址同步给 bridge 的反代上游。
//
// 上游切换失败意味着界面上的接口请求会打到旧地址，但用户至少还能看到
// 实例已添加并在下次重试——因此这里不把错误抛给调用方。
func (s *SessionService) syncUpstream(baseURL string) {
	// 读字段不加锁：它在装配阶段一次性写入，此后只读。
	// 加锁会与下面的 mu 使用顺序耦合，反而更容易出错。
	setter := s.UpstreamSetter
	if setter != nil && baseURL != "" {
		_ = setter(baseURL)
	}
}

/* ------------------------------------------------------------------ */
/* 实例管理                                                            */
/* ------------------------------------------------------------------ */

// ListInstances 返回已保存实例。
func (s *SessionService) ListInstances() ([]store.Instance, error) {
	return s.store.ListInstances()
}

// AddInstance 探活并保存实例。
//
// 先探活再保存：让用户在添加时就立刻知道"这个地址连不上/版本太旧"，
// 而不是先存下来、登录时才失败。
func (s *SessionService) AddInstance(baseURL string) (store.Instance, InstanceInfo) {
	info := s.Probe(baseURL)
	if !info.Reachable {
		return store.Instance{}, info
	}

	id := instanceIDFromURL(baseURL)
	it := store.Instance{
		ID:      id,
		BaseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		Name:    info.Title,
		Version: info.Version,
	}
	if it.Name == "" {
		it.Name = it.BaseURL
	}
	_ = s.store.SaveInstance(it)

	// 回查库里真正生效的那一行：SaveInstance 按 base_url 冲突时保留原有 id，
	// 此时上面算出的 id 在库里并不存在，拿它当活动实例会让后续登录报"实例不存在"。
	persisted, ok, err := s.store.GetInstanceByBaseURL(it.BaseURL)
	if err != nil || !ok {
		persisted = it
	}

	// 添加即切换：前端拿到"实例已保存"后立刻要查活动实例来渲染登录页，
	// 这里不设置就会让用户刚填完地址又被弹回同一个表单。
	s.mu.Lock()
	s.activeInstanceID = persisted.ID
	s.mu.Unlock()

	// 同步给 bridge：不加这一步，登录成功后所有接口请求都会打到占位上游。
	s.syncUpstream(persisted.BaseURL)

	return persisted, info
}

// SetActiveInstance 切换当前使用的实例。
//
// Args:
//
//	id: 目标实例 ID
//
// Returns:
//
//	实例不存在时返回错误，且保持原有活动实例不变——界面不该因为一次
//	失败的切换而失去数据源。
//
// 切换会清掉内存里的 access token：token 属于特定实例，
// 带着上一台的 token 去请求新实例只会换来一个 401。
func (s *SessionService) SetActiveInstance(id string) error {
	it, ok, err := s.store.GetInstance(id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("实例不存在: %s", id)
	}

	s.mu.Lock()
	s.activeInstanceID = id
	s.accessToken = ""
	s.mu.Unlock()

	s.syncUpstream(it.BaseURL)
	return nil
}

// RemoveInstance 删除实例并清理其凭据。
func (s *SessionService) RemoveInstance(id string) error {
	_ = s.keychain.Delete(refreshKey(id))
	if err := s.store.DeleteInstance(id); err != nil {
		return err
	}
	s.mu.Lock()
	if s.activeInstanceID == id {
		s.activeInstanceID = ""
		s.accessToken = ""
	}
	s.mu.Unlock()
	return nil
}

// ActiveInstance 返回当前实例；未选择时返回 false。
func (s *SessionService) ActiveInstance() (store.Instance, bool, error) {
	s.mu.RLock()
	id := s.activeInstanceID
	s.mu.RUnlock()
	if id == "" {
		return store.Instance{}, false, nil
	}
	return s.store.GetInstance(id)
}

/* ------------------------------------------------------------------ */
/* 登录 / 登出 / 刷新                                                   */
/* ------------------------------------------------------------------ */

// Login 用用户名密码登录，成功后把 refresh 存进 Keychain。
//
// Args:
//
//	instanceID: 目标实例 ID
//	username:   用户名
//	password:   密码（只在本次调用内存在，不落盘）
//
// Returns:
//
//	凭据（含 access token）；失败时 Success=false 且给出可读原因。
func (s *SessionService) Login(instanceID, username, password string) (Credentials, LoginResult) {
	it, ok, err := s.store.GetInstance(instanceID)
	if err != nil || !ok {
		return Credentials{}, LoginResult{Error: "实例不存在，请先添加实例", ErrorCode: "instance_not_found"}
	}

	deviceID, deviceName := s.deviceIdentity()
	payload := map[string]any{
		"username":    username,
		"password":    password,
		"device_id":   deviceID,
		"device_name": deviceName,
		"platform":    "desktop",
	}

	var resp loginResponse
	status, err := s.postJSON(it.BaseURL, "/api/v1/auth/login", payload, &resp, "")
	if err != nil {
		return Credentials{}, LoginResult{Error: "无法连接实例: " + err.Error(), ErrorCode: "network_error"}
	}
	if status == http.StatusUnauthorized {
		return Credentials{}, LoginResult{Error: "用户名或密码错误", ErrorCode: "invalid_credentials"}
	}
	if status != http.StatusOK {
		return Credentials{}, LoginResult{
			Error:     fmt.Sprintf("登录失败（HTTP %d）", status),
			ErrorCode: "login_failed",
		}
	}

	// refresh 只进 Keychain；access 交给 JS 内存。
	if err := s.keychain.Set(refreshKey(instanceID), resp.RefreshToken); err != nil {
		return Credentials{}, LoginResult{Error: "保存凭据失败: " + err.Error(), ErrorCode: "keychain_error"}
	}

	s.mu.Lock()
	s.activeInstanceID = instanceID
	s.accessToken = resp.Token
	s.deviceID = deviceID
	s.mu.Unlock()

	return Credentials{
		AccessToken: resp.Token,
		UserID:      resp.ID,
		Username:    resp.Username,
		IsAdmin:     resp.IsAdmin,
		InstanceID:  instanceID,
		Persistent:  s.keychain.Persistent(),
	}, LoginResult{Success: true}
}

// Logout 撤销 refresh 并清理本地凭据。
//
// 即便远端撤销失败也要清本地：用户点了"退出"就必须真的退出，
// 不能因为网络问题把人留在已登录状态。
func (s *SessionService) Logout() error {
	s.mu.RLock()
	instanceID, token := s.activeInstanceID, s.accessToken
	s.mu.RUnlock()

	if instanceID == "" {
		return nil
	}
	it, ok, _ := s.store.GetInstance(instanceID)
	var revokeErr error
	if ok {
		refresh, err := s.keychain.Get(refreshKey(instanceID))
		if err == nil && refresh != "" {
			body := map[string]any{"refresh_token": refresh}
			status, err := s.postJSON(it.BaseURL, "/api/v1/auth/logout", body, nil, token)
			if err != nil || (status != http.StatusOK && status != http.StatusNoContent) {
				revokeErr = fmt.Errorf("远端登出失败（HTTP %d）", status)
			}
		}
	}

	_ = s.keychain.Delete(refreshKey(instanceID))
	s.mu.Lock()
	s.accessToken = ""
	s.mu.Unlock()

	return revokeErr
}

// AccessToken 返回当前 access token（供 bridge 注入 Authorization）。
func (s *SessionService) AccessToken() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.accessToken
}

// RestoreSession 在启动时用 Keychain 里的 refresh 恢复登录态。
//
// 返回凭据；无可用 refresh 时返回 false（不视为错误——首次启动就是这样）。
func (s *SessionService) RestoreSession(instanceID string) (Credentials, bool) {
	// 先对上上游：恢复会话之后界面立刻要发接口请求，此时 bridge 必须
	// 已经指向这台实例，否则用户的每次请求都打在占位地址上。
	if it, ok, err := s.store.GetInstance(instanceID); err == nil && ok {
		s.syncUpstream(it.BaseURL)
	}

	refresh, err := s.keychain.Get(refreshKey(instanceID))
	if err != nil || refresh == "" {
		return Credentials{}, false
	}

	creds, ok := s.refreshNow(instanceID, refresh)
	if !ok {
		// refresh 已失效（过期/被吊销/重用）：清掉它，让用户重新登录。
		_ = s.keychain.Delete(refreshKey(instanceID))
		return Credentials{}, false
	}
	return creds, true
}

// Refresh 刷新 access token（全局 single-flight）。
//
// 并发调用**共用同一次真实刷新**：后端 refresh 带重用检测，同时打两次会
// 触发 family 吊销，把用户所有设备一起踢下线。Web 端多标签页各刷一次已经
// 踩过这个坑；桌面端所有窗口共享一个 Go 进程，天然只需合并一次——这是
// 桌面架构的便宜收益，不能浪费。
//
// 注意这里合并的是"飞行中的请求"，而不只是串行化：只加锁而不合并，
// 20 个并发仍会依次打 20 次，正是要避免的行为。
func (s *SessionService) Refresh() (Credentials, bool) {
	s.refreshMu.Lock()
	// 别人已经在刷新：等它结束，直接复用它的结果。
	if s.inflight != nil {
		ch := s.inflight
		s.refreshMu.Unlock()
		res := <-ch
		return res.creds, res.ok
	}
	// 我是第一个：登记一个 channel，让后来者等它。
	ch := make(chan refreshResult, 1)
	s.inflight = ch
	s.refreshMu.Unlock()

	creds, ok := s.doRefresh()

	s.refreshMu.Lock()
	s.inflight = nil
	s.refreshMu.Unlock()
	// 带缓冲，即使没人等也不会阻塞。
	ch <- refreshResult{creds: creds, ok: ok}
	close(ch)

	return creds, ok
}

// refreshResult 是共享给并发等待者的结果。
type refreshResult struct {
	creds Credentials
	ok    bool
}

// doRefresh 执行一次真实刷新。
func (s *SessionService) doRefresh() (Credentials, bool) {
	s.mu.RLock()
	instanceID := s.activeInstanceID
	s.mu.RUnlock()
	if instanceID == "" {
		return Credentials{}, false
	}

	refresh, err := s.keychain.Get(refreshKey(instanceID))
	if err != nil || refresh == "" {
		return Credentials{}, false
	}
	return s.refreshNow(instanceID, refresh)
}

// refreshNow 执行一次真实刷新（调用方必须已持有 refreshMu）。
func (s *SessionService) refreshNow(instanceID, refresh string) (Credentials, bool) {
	it, ok, err := s.store.GetInstance(instanceID)
	if err != nil || !ok {
		return Credentials{}, false
	}

	var resp refreshResponse
	status, err := s.postJSON(
		it.BaseURL, "/api/v1/auth/refresh",
		map[string]any{"refresh_token": refresh}, &resp, "",
	)
	if err != nil || status != http.StatusOK {
		return Credentials{}, false
	}

	// 轮换后的 refresh 必须写回：后端把它标记为已轮换，
	// 继续用旧的会触发重用检测。
	if err := s.keychain.Set(refreshKey(instanceID), resp.RefreshToken); err != nil {
		return Credentials{}, false
	}

	s.mu.Lock()
	s.activeInstanceID = instanceID
	s.accessToken = resp.AccessToken
	s.mu.Unlock()

	return Credentials{
		AccessToken: resp.AccessToken,
		InstanceID:  instanceID,
		Persistent:  s.keychain.Persistent(),
	}, true
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

type loginResponse struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	IsAdmin      bool   `json:"is_admin"`
	Token        string `json:"token"`
	RefreshToken string `json:"refresh_token"`
}

type refreshResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
}

// postJSON 发 POST 并解析响应；status 即使非 2xx 也返回（让调用方分支）。
func (s *SessionService) postJSON(base, path string, body any, out any, bearer string) (int, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return 0, fmt.Errorf("序列化请求失败: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(base, "/")+path, bytes.NewReader(raw))
	if err != nil {
		return 0, fmt.Errorf("构造请求失败: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()

	if out != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if err != nil {
			return resp.StatusCode, fmt.Errorf("读取响应失败: %w", err)
		}
		if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, fmt.Errorf("解析响应失败: %w", err)
		}
	}
	return resp.StatusCode, nil
}

// refreshKey 是 Keychain 里每条凭据的键。
//
// 按实例隔离：一个人同时连公司实例和个人实例是常态，
// 共用一个键会让两者互相覆盖。
func refreshKey(instanceID string) string {
	return "refresh:" + instanceID
}

// instanceIDFromURL 由地址派生稳定 ID。
//
// 用地址而不是随机 UUID：同一个实例重复添加时能命中同一行，
// 用户不会在切换器里看到两个相同条目。
//
// 用 SHA-256 而不是手写折叠：早期实现按字节取模异或，前 16 字节之后
// 的信息被 XOR 相互抵消，不同地址极易碰撞成同一个 ID——测试里两台不同
// 实例就合并成了一行。哈希要的就是碰撞抵抗，不该在这里省。
func instanceIDFromURL(baseURL string) string {
	normalized := strings.ToLower(strings.TrimRight(strings.TrimSpace(baseURL), "/"))
	sum := sha256.Sum256([]byte(normalized))
	// 取前 16 字节即可：它是本地标识，不承担密码学安全职责，
	// 但必须对输入差异敏感。
	return base64.RawURLEncoding.EncodeToString(sum[:16])
}

// deviceIdentity 返回本机的设备标识与显示名。
//
// 设备 ID 首次生成后持久化到 Keychain：用户需要在"已登录设备"里
// 辨认并定向吊销某台机器，而不是只能"全部登出"。
func (s *SessionService) deviceIdentity() (string, string) {
	s.mu.RLock()
	if s.deviceID != "" {
		id := s.deviceID
		s.mu.RUnlock()
		return id, deviceName()
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deviceID != "" {
		return s.deviceID, deviceName()
	}

	if existing, err := s.keychain.Get("device_id"); err == nil && existing != "" {
		s.deviceID = existing
		return existing, deviceName()
	}

	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	id := base64.RawURLEncoding.EncodeToString(buf)
	_ = s.keychain.Set("device_id", id)
	s.deviceID = id
	return id, deviceName()
}

// deviceName 是给人看的设备名。
func deviceName() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return "Kustos Desktop"
	}
	return "Kustos Desktop (" + host + ")"
}
