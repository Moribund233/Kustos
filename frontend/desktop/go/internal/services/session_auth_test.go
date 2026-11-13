package services

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kustos/kustos-desktop/internal/platform/keychain"
	"github.com/kustos/kustos-desktop/internal/store"
)

// 登录与刷新是会话层的核心路径，且有几个反直觉的约束：
//   - refresh token 不能出现在返回给前端的结构里；
//   - 并发刷新必须只打一次（后端重用检测会吊销整个 family）；
//   - 远端登出失败也要清本地凭据。

func newAuthTestService(t *testing.T, handler http.HandlerFunc) (*SessionService, *httptest.Server, *store.DB, *keychain.Composite) {
	t.Helper()

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	kc := keychain.NewCompositeWith(keychain.NewMemoryStore(), keychain.NewMemoryStore())
	svc := NewSessionServiceWith(db, kc)

	// 预置实例，让 Login 能找到它。
	_ = db.SaveInstance(store.Instance{ID: "inst1", BaseURL: srv.URL, Name: "测试实例"})

	return svc, srv, db, kc
}

func TestLoginSuccessStoresRefreshInKeychainOnly(t *testing.T) {
	svc, _, _, kc := newAuthTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/auth/login" {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		// 设备标识必须上报，否则"已登录设备"里看不到这台机器。
		if body["device_id"] == "" || body["platform"] != "desktop" {
			t.Errorf("应上报设备标识，实际 %+v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"u1","username":"alice","is_admin":true,
			"token":"access-1","refresh_token":"refresh-1"
		}`))
	})

	creds, result := svc.Login("inst1", "alice", "pw")

	if !result.Success {
		t.Fatalf("登录应成功，实际 %+v", result)
	}
	if creds.AccessToken != "access-1" {
		t.Errorf("access token = %q", creds.AccessToken)
	}
	// 核心安全约束：refresh 必须在 Keychain，且不出现在返回结构里。
	stored, err := kc.Get(refreshKey("inst1"))
	if err != nil || stored != "refresh-1" {
		t.Fatalf("refresh 应存入 keychain，实际 %q, %v", stored, err)
	}
}

func TestLoginInvalidCredentials(t *testing.T) {
	svc, _, _, _ := newAuthTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})

	_, result := svc.Login("inst1", "alice", "wrong")

	if result.Success {
		t.Fatal("401 应失败")
	}
	if result.ErrorCode != "invalid_credentials" {
		t.Errorf("errorCode = %q，前端据此提示重输密码", result.ErrorCode)
	}
}

func TestLoginUnknownInstance(t *testing.T) {
	svc, _, _, _ := newAuthTestService(t, func(w http.ResponseWriter, _ *http.Request) {})

	_, result := svc.Login("no-such-instance", "a", "b")

	if result.Success || result.ErrorCode != "instance_not_found" {
		t.Fatalf("应报实例不存在，实际 %+v", result)
	}
}

// 后端 refresh 带重用检测：并发刷新会吊销整个 family。
// 桌面端所有窗口共用一个 Go 进程，因此这把锁必须真的生效。
func TestRefreshIsSingleFlight(t *testing.T) {
	var calls int32
	svc, _, _, _ := newAuthTestService(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/auth/login":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"u1","username":"a","token":"t1","refresh_token":"r1"}`))
		case "/api/v1/auth/refresh":
			atomic.AddInt32(&calls, 1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"t2","refresh_token":"r2","token_type":"bearer"}`))
		default:
			http.NotFound(w, r)
		}
	})

	if _, res := svc.Login("inst1", "a", "p"); !res.Success {
		t.Fatalf("登录失败: %+v", res)
	}

	// 20 个并发刷新只应产生 1 次真实请求。
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = svc.Refresh()
		}()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("并发刷新应只打 1 次（否则触发 family 吊销），实际 %d 次", got)
	}
}

// 轮换后的 refresh 必须写回：继续用旧的会触发重用检测。
func TestRefreshRotatesStoredToken(t *testing.T) {
	svc, _, _, kc := newAuthTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/auth/login":
			_, _ = w.Write([]byte(`{"id":"u1","username":"a","token":"t1","refresh_token":"r1"}`))
		case "/api/v1/auth/refresh":
			_, _ = w.Write([]byte(`{"access_token":"t2","refresh_token":"r2"}`))
		}
	})

	_, _ = svc.Login("inst1", "a", "p")
	if _, ok := svc.Refresh(); !ok {
		t.Fatal("刷新应成功")
	}

	stored, _ := kc.Get(refreshKey("inst1"))
	if stored != "r2" {
		t.Fatalf("轮换后的 refresh 应写回，实际 %q", stored)
	}
}

// 远端登出失败也必须清本地：用户点了退出就要真的退出。
func TestLogoutClearsLocalEvenIfRemoteFails(t *testing.T) {
	svc, _, _, kc := newAuthTestService(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/auth/login":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"u1","username":"a","token":"t1","refresh_token":"r1"}`))
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	})

	_, _ = svc.Login("inst1", "a", "p")
	if svc.AccessToken() != "t1" {
		t.Fatal("登录后应有 access token")
	}

	_ = svc.Logout() // 远端 500，但仍应清本地

	if svc.AccessToken() != "" {
		t.Error("登出后 access token 应为空")
	}
	if _, err := kc.Get(refreshKey("inst1")); err == nil {
		t.Error("登出后 keychain 里的 refresh 应被删除")
	}
}

// Keychain 里没有 refresh 时不能恢复会话（首次启动就是这样）。
func TestRestoreSessionWithoutRefresh(t *testing.T) {
	svc, _, _, _ := newAuthTestService(t, func(http.ResponseWriter, *http.Request) {})

	if _, ok := svc.RestoreSession("inst1"); ok {
		t.Fatal("无 refresh 时不应恢复出会话")
	}
}

// refresh 失效时应清掉它，避免每次启动都拿一个死令牌去试。
func TestRestoreSessionClearsDeadRefresh(t *testing.T) {
	svc, _, _, kc := newAuthTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	_ = kc.Set(refreshKey("inst1"), "dead-token")

	if _, ok := svc.RestoreSession("inst1"); ok {
		t.Fatal("失效 refresh 不应恢复成功")
	}
	if _, err := kc.Get(refreshKey("inst1")); err == nil {
		t.Error("失效的 refresh 应被清除")
	}
}

// 同一地址重复添加应命中同一行（instanceIDFromURL 稳定，
// 且 store 按 base_url upsert）。
//
// 注意：夹具里预置的实例用的也是 srv.URL，所以"添加两次"最终只应有
// 1 行——这正好同时验证了 ID 稳定与 upsert 合并两件事。
func TestAddInstanceIsStable(t *testing.T) {
	svc, srv, db, _ := newAuthTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"title":"实例","version":"1.0"}`))
			return
		}
		http.NotFound(w, r)
	})

	first, _ := svc.AddInstance(srv.URL)
	second, _ := svc.AddInstance(srv.URL + "/")

	if first.ID != second.ID {
		t.Fatalf("同一地址应得到同一 ID: %q vs %q", first.ID, second.ID)
	}
	list, _ := db.ListInstances()
	if len(list) != 1 {
		t.Fatalf("同一地址重复添加应合并为 1 行，实际 %d 行", len(list))
	}
}

// 添加实例必须把地址同步给 bridge 的上游。
//
// 不同步的话，界面能登录成功，但之后每个接口请求都会打到占位上游——
// 表现为"登录成功了但界面全是空的"。
func TestAddInstanceSyncsUpstream(t *testing.T) {
	svc, srv, _, _ := newAuthTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"title":"实例","version":"1.0"}`))
			return
		}
		http.NotFound(w, r)
	})

	var got string
	svc.UpstreamSetter = func(base string) error {
		got = base
		return nil
	}

	svc.AddInstance(srv.URL)

	if got != srv.URL {
		t.Fatalf("上游应被同步为 %q，实际 %q", srv.URL, got)
	}
}

// 切换实例同样要同步上游，否则界面会继续读上一台实例的数据。
func TestSetActiveInstanceSyncsUpstream(t *testing.T) {
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	defer func() { _ = db.Close() }()

	kc := keychain.NewCompositeWith(keychain.NewMemoryStore(), keychain.NewMemoryStore())
	svc := NewSessionServiceWith(db, kc)

	_ = db.SaveInstance(store.Instance{ID: "a", BaseURL: "https://a.example"})
	_ = db.SaveInstance(store.Instance{ID: "b", BaseURL: "https://b.example"})

	var got string
	svc.UpstreamSetter = func(base string) error {
		got = base
		return nil
	}

	if err := svc.SetActiveInstance("b"); err != nil {
		t.Fatalf("切换失败: %v", err)
	}
	if got != "https://b.example" {
		t.Fatalf("上游应切到 b，实际 %q", got)
	}
}

// 切换失败时不能改动上游：界面不该因为一次失败的切换而失去数据源。
func TestSetActiveInstanceFailureKeepsUpstream(t *testing.T) {
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	defer func() { _ = db.Close() }()

	kc := keychain.NewCompositeWith(keychain.NewMemoryStore(), keychain.NewMemoryStore())
	svc := NewSessionServiceWith(db, kc)

	called := false
	svc.UpstreamSetter = func(string) error {
		called = true
		return nil
	}

	if err := svc.SetActiveInstance("nope"); err == nil {
		t.Fatal("不存在的实例应报错")
	}
	if called {
		t.Fatal("切换失败时不应改动上游")
	}
}

// 添加实例必须同时把它设为活动实例。
//
// 否则前端拿到"实例已保存"却查不到活动实例，会再次渲染连接页——
// 用户刚填完地址又被弹回同一个表单，永远走不到登录页。
func TestAddInstanceBecomesActive(t *testing.T) {
	svc, srv, _, _ := newAuthTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"title":"实例","version":"1.0"}`))
			return
		}
		http.NotFound(w, r)
	})

	added, info := svc.AddInstance(srv.URL)
	if !info.Reachable {
		t.Fatalf("实例应可达: %+v", info)
	}

	active, ok, err := svc.ActiveInstance()
	if err != nil {
		t.Fatalf("查询活动实例失败: %v", err)
	}
	if !ok {
		t.Fatal("添加实例后应成为活动实例，否则前端会卡在连接页")
	}
	if active.ID != added.ID {
		t.Fatalf("活动实例应为刚添加的那台: %q vs %q", active.ID, added.ID)
	}
}

// 不可达的实例不应被设为活动实例：否则前端会对着一个连不上的地址渲染主界面。
func TestAddUnreachableInstanceDoesNotBecomeActive(t *testing.T) {
	svc, _, _, _ := newAuthTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	_, info := svc.AddInstance("http://127.0.0.1:1")
	if info.Reachable {
		t.Fatal("不可达的地址不应报告可达")
	}

	if _, ok, _ := svc.ActiveInstance(); ok {
		t.Fatal("不可达的实例不应成为活动实例")
	}
}

// 切换实例：SetActiveInstance 应改变活动实例而不需要重新添加。
func TestSetActiveInstance(t *testing.T) {
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	defer func() { _ = db.Close() }()

	kc := keychain.NewCompositeWith(keychain.NewMemoryStore(), keychain.NewMemoryStore())
	svc := NewSessionServiceWith(db, kc)

	_ = db.SaveInstance(store.Instance{ID: "a", BaseURL: "https://a.example"})
	_ = db.SaveInstance(store.Instance{ID: "b", BaseURL: "https://b.example"})

	if err := svc.SetActiveInstance("b"); err != nil {
		t.Fatalf("切换失败: %v", err)
	}
	active, ok, _ := svc.ActiveInstance()
	if !ok || active.ID != "b" {
		t.Fatalf("活动实例应为 b，实际 %+v（ok=%v）", active, ok)
	}

	// 不存在的实例不能被设为活动实例：否则界面会显示一个查不到的数据源。
	if err := svc.SetActiveInstance("nope"); err == nil {
		t.Fatal("不存在的实例应报错")
	}
}

// 不同地址必须是不同行——早期实现用手写折叠哈希，两台不同实例
// 会碰撞成同一个 ID 并互相覆盖。
func TestDifferentInstancesDoNotCollide(t *testing.T) {
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	defer func() { _ = db.Close() }()

	for _, url := range []string{
		"https://a.example.com",
		"https://b.example.com",
		"http://127.0.0.1:8000",
		"http://127.0.0.1:8001",
	} {
		_ = db.SaveInstance(store.Instance{ID: instanceIDFromURL(url), BaseURL: url})
	}

	list, _ := db.ListInstances()
	if len(list) != 4 {
		t.Fatalf("四台不同实例应各占一行，实际 %d 行（ID 碰撞）", len(list))
	}
}

/* ------------------------------------------------------------------ */
/* 联网 git 命令的取令牌路径                                             */
/* ------------------------------------------------------------------ */

// push/fetch 没有 HTTP 那套 401 重试兜底：带上过期令牌只会换来一句用户
// 看不懂的认证错误，所以这里要保证交出去的大概率还活着。

// jwtWithExp 造一枚形状合法的假 JWT，payload 里只关心 exp。
func jwtWithExp(t *testing.T, exp time.Time) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	claims, err := json.Marshal(map[string]any{"sub": "u1", "exp": exp.Unix()})
	if err != nil {
		t.Fatalf("构造 claims 失败: %v", err)
	}
	payload := base64.RawURLEncoding.EncodeToString(claims)
	// 签名段是假的：这里的用途是"什么时候该换一枚"的缓存提示，不验签。
	return header + "." + payload + ".c2ln"
}

// 令牌还没临期时不该刷新：每次 push 前都打一次 /auth/refresh 是白白增加
// 被重用检测盯上的机会。
func TestFreshAccessTokenSkipsRefreshWhenStillValid(t *testing.T) {
	var refreshCalls int32
	svc, _, _, _ := newAuthTestService(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/auth/login":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"u1","username":"a","token":"` +
				jwtWithExp(t, time.Now().Add(20*time.Minute)) + `","refresh_token":"r1"}`))
		case "/api/v1/auth/refresh":
			atomic.AddInt32(&refreshCalls, 1)
			w.WriteHeader(http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	})

	if _, res := svc.Login("inst1", "a", "p"); !res.Success {
		t.Fatalf("登录失败: %+v", res)
	}

	got := svc.FreshAccessToken()
	if got != svc.AccessToken() {
		t.Fatal("未临期时应当原样返回内存里的令牌")
	}
	if calls := atomic.LoadInt32(&refreshCalls); calls != 0 {
		t.Fatalf("未临期时不该刷新，实际打了 %d 次", calls)
	}
}

// 临期（不足 refreshLeeway 的余量）就先换一枚：否则命令还没发完令牌就过期了。
func TestFreshAccessTokenRefreshesNearExpiry(t *testing.T) {
	var refreshCalls int32
	nearExpiry := jwtWithExp(t, time.Now().Add(5*time.Second))
	fresh := jwtWithExp(t, time.Now().Add(30*time.Minute))

	svc, _, _, _ := newAuthTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/auth/login":
			_, _ = w.Write([]byte(`{"id":"u1","username":"a","token":"` + nearExpiry + `","refresh_token":"r1"}`))
		case "/api/v1/auth/refresh":
			atomic.AddInt32(&refreshCalls, 1)
			_, _ = w.Write([]byte(`{"access_token":"` + fresh + `","refresh_token":"r2"}`))
		default:
			http.NotFound(w, r)
		}
	})

	if _, res := svc.Login("inst1", "a", "p"); !res.Success {
		t.Fatalf("登录失败: %+v", res)
	}

	if got := svc.FreshAccessToken(); got != fresh {
		t.Fatal("临期时应当返回刷新后的令牌")
	}
	if calls := atomic.LoadInt32(&refreshCalls); calls != 1 {
		t.Fatalf("应当恰好刷新 1 次，实际 %d 次", calls)
	}
}

// 刷新失败时退回内存里那枚而不是空串：令牌"可能"过期不等于"一定"过期，
// 让这次操作试一次，比直接告诉用户"登录已失效"更贴近事实。
func TestFreshAccessTokenFallsBackOnRefreshFailure(t *testing.T) {
	stale := jwtWithExp(t, time.Now().Add(-1*time.Minute))
	svc, _, _, _ := newAuthTestService(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/auth/login":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"u1","username":"a","token":"` + stale + `","refresh_token":"r1"}`))
		case "/api/v1/auth/refresh":
			w.WriteHeader(http.StatusUnauthorized)
		default:
			http.NotFound(w, r)
		}
	})

	if _, res := svc.Login("inst1", "a", "p"); !res.Success {
		t.Fatalf("登录失败: %+v", res)
	}

	if got := svc.FreshAccessToken(); got != stale {
		t.Fatalf("刷新失败时应退回现有令牌，得到 %q", got)
	}
}

// 令牌形状不对（不是标准 JWT）时不强制刷新：把"解不出"当成"已过期"，
// 每一步都会多打一次 refresh，代价比偶尔一次认证失败大得多。
func TestFreshAccessTokenWithoutReadableExpiry(t *testing.T) {
	var refreshCalls int32
	svc, _, _, _ := newAuthTestService(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/auth/login":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"u1","username":"a","token":"opaque-token","refresh_token":"r1"}`))
		case "/api/v1/auth/refresh":
			atomic.AddInt32(&refreshCalls, 1)
			w.WriteHeader(http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	})

	if _, res := svc.Login("inst1", "a", "p"); !res.Success {
		t.Fatalf("登录失败: %+v", res)
	}
	if got := svc.FreshAccessToken(); got != "opaque-token" {
		t.Fatalf("解不出 exp 时应原样返回，得到 %q", got)
	}
	if calls := atomic.LoadInt32(&refreshCalls); calls != 0 {
		t.Fatalf("解不出 exp 时不该刷新，实际打了 %d 次", calls)
	}
}

// 未登录时不刷新、不编造：空串就是"没有凭据"，调用方据此决定不注入。
func TestFreshAccessTokenWithoutSession(t *testing.T) {
	var refreshCalls int32
	svc, _, _, _ := newAuthTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&refreshCalls, 1)
		w.WriteHeader(http.StatusInternalServerError)
	})

	if got := svc.FreshAccessToken(); got != "" {
		t.Fatalf("未登录时应返回空串，得到 %q", got)
	}
	if calls := atomic.LoadInt32(&refreshCalls); calls != 0 {
		t.Fatalf("没有会话时不该打刷新，实际 %d 次", calls)
	}
}

// exp 的读取只解码不验签，因此要能容忍几种真实存在的写法。
func TestAccessTokenExpiryShapes(t *testing.T) {
	later := time.Now().Add(10 * time.Minute)

	cases := []struct {
		name    string
		token   string
		wantSet bool
		want    time.Time
	}{
		{"标准三段", jwtWithExp(t, later), true, later.Truncate(time.Second)},
		{"两段（不是 JWT）", "header.payload", false, time.Time{}},
		{"签名段缺失", "a.b.", false, time.Time{}},
		{"空串", "", false, time.Time{}},
		{"payload 不是 base64", "a.!!!.c", false, time.Time{}},
		{"payload 不是 JSON", base64.RawURLEncoding.EncodeToString([]byte("a")) +
			"." + base64.RawURLEncoding.EncodeToString([]byte("not json")) + ".c", false, time.Time{}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := accessTokenExpiry(tc.token)
			if got.IsZero() == tc.wantSet {
				t.Fatalf("是否解出 exp = %v，期望 %v（得到 %v）", !got.IsZero(), tc.wantSet, got)
			}
			if tc.wantSet && !got.Equal(tc.want) {
				t.Fatalf("exp = %v，期望 %v", got, tc.want)
			}
		})
	}
}

// exp 以整数秒写在 payload 里也要能读出来；用 RawMessage 保证序列化出来
// 就是整数，不会因 Go 把数字写成浮点而误判成"读不出来"。
func TestAccessTokenExpiryAcceptsIntegerSeconds(t *testing.T) {
	secs := time.Now().Add(3 * time.Minute).Unix()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	claims, err := json.Marshal(map[string]json.RawMessage{"exp": json.RawMessage(strconv.FormatInt(secs, 10))})
	if err != nil {
		t.Fatalf("构造 claims 失败: %v", err)
	}
	token := header + "." + base64.RawURLEncoding.EncodeToString(claims) + ".sig"

	got := accessTokenExpiry(token)
	if got.IsZero() {
		t.Fatal("应当解出 exp")
	}
	if got.Unix() != secs {
		t.Fatalf("exp = %v，期望 %d", got, secs)
	}
}

// 登录写入的过期时刻必须与令牌一致：否则"临期判断"读的是另一枚令牌的时间。
func TestLoginRecordsExpiryWithToken(t *testing.T) {
	exp := time.Now().Add(7 * time.Minute)
	token := jwtWithExp(t, exp)
	svc, _, _, _ := newAuthTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"u1","username":"a","token":"` + token + `","refresh_token":"r1"}`))
	})

	if _, res := svc.Login("inst1", "a", "p"); !res.Success {
		t.Fatalf("登录失败: %+v", res)
	}

	svc.mu.RLock()
	got := svc.accessTokenExp
	svc.mu.RUnlock()
	if got.IsZero() {
		t.Fatal("登录后应记下令牌的过期时刻")
	}
	if !got.Equal(exp.Truncate(time.Second)) {
		t.Fatalf("过期时刻 = %v，期望 %v", got, exp)
	}
}

// 登出与切实例必须把过期时刻一起清掉：留下"旧 exp 配空令牌"这种半状态，
// 下一次判断会拿着不存在的时间做决策。
func TestClearingSessionAlsoClearsExpiry(t *testing.T) {
	svc, _, _, _ := newAuthTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/auth/login":
			_, _ = w.Write([]byte(`{"id":"u1","username":"a","token":"` +
				jwtWithExp(t, time.Now().Add(20*time.Minute)) + `","refresh_token":"r1"}`))
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	})

	if _, res := svc.Login("inst1", "a", "p"); !res.Success {
		t.Fatalf("登录失败: %+v", res)
	}
	_ = svc.Logout()

	svc.mu.RLock()
	exp := svc.accessTokenExp
	svc.mu.RUnlock()
	if !exp.IsZero() {
		t.Fatalf("登出后过期时刻应清零，得到 %v", exp)
	}
}
