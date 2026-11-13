package services

import (
	"strings"
	"testing"

	"github.com/kustos/kustos-desktop/internal/store"
)

// 缓存服务的职责很窄：存一份、按 key 取回来、顺手清理。这几条断言钉住的是
// "不会假装成功"——未接线的本地库上返回 true 会让界面以为断网时读到了数据。

func newCacheService(t *testing.T) *OfflineCacheService {
	t.Helper()
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewOfflineCacheService(db)
}

func TestOfflineCachePutAndGet(t *testing.T) {
	svc := newCacheService(t)

	if err := svc.Put("inbox:list", `{"items":[]}`); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	got, ok, err := svc.Get("inbox:list")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if !ok {
		t.Fatal("刚写入的缓存应当命中")
	}
	if got.Payload != `{"items":[]}` {
		t.Fatalf("内容应原样返回，实际 %q", got.Payload)
	}
	// 时间必须落在毫秒量级：纳秒超出 JS 安全整数范围，经绑定层会被舍入。
	if got.FetchedAt < 1_000_000_000_000 {
		t.Fatalf("取回时间应为毫秒，实际 %d", got.FetchedAt)
	}
}

func TestOfflineCacheGetMiss(t *testing.T) {
	svc := newCacheService(t)
	_, ok, err := svc.Get("never-written")
	if err != nil {
		t.Fatalf("未命中不该是错误: %v", err)
	}
	if ok {
		t.Fatal("没写过的 key 不该命中")
	}
}

func TestOfflineCacheRejectsBlankKey(t *testing.T) {
	svc := newCacheService(t)
	if err := svc.Put("   ", "x"); err == nil {
		t.Fatal("空白 key 应被拒绝")
	}
}

func TestOfflineCacheRejectsOversizedPayload(t *testing.T) {
	svc := newCacheService(t)
	huge := strings.Repeat("x", offlineCacheMaxPayload+1)
	err := svc.Put("big", huge)
	if err == nil {
		t.Fatal("超过上限的内容应被拒绝")
	}
	if !strings.Contains(err.Error(), "上限") {
		t.Fatalf("错误信息应说明是上限问题，实际 %q", err.Error())
	}
}

func TestOfflineCacheWithoutStoreFailsLoudly(t *testing.T) {
	// 未接线时不能静默成功：界面会以为断网时能读到数据。
	svc := NewOfflineCacheService(nil)
	if err := svc.Put("k", "v"); err == nil {
		t.Fatal("本地库未接线时 Put 应报错")
	}
	if _, ok, err := svc.Get("k"); err == nil || ok {
		t.Fatal("本地库未接线时 Get 应报错且不算命中")
	}
	if svc.Prune() != 0 {
		t.Fatal("本地库未接线时清理应返回 0")
	}
}
