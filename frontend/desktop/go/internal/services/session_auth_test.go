package services

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

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
