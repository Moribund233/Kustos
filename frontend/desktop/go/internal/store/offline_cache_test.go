package store

import (
	"testing"
	"time"
)

// openTestDB 打开一个内存库并跑完全部迁移。
func openTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// 离线缓存只在断网时才有价值。这几条断言钉住的是"读到的确实是取回来的那份"
// 与"旧数据会自己消失"——两者错了都很难从现象反推：前者让用户以为数据没变，
// 后者让库悄悄长大。

func TestOfflineCacheRoundTrip(t *testing.T) {
	db := openTestDB(t)

	if err := db.SetOfflineCache("inbox:list", `{"items":[]}`); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	got, ok, err := db.GetOfflineCache("inbox:list", 0)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if !ok {
		t.Fatal("刚写入的缓存应当命中")
	}
	if got.Payload != `{"items":[]}` {
		t.Fatalf("内容应原样返回，实际 %q", got.Payload)
	}
}

func TestOfflineCacheOverwrites(t *testing.T) {
	db := openTestDB(t)

	if err := db.SetOfflineCache("pr:1", `{"a":1}`); err != nil {
		t.Fatalf("首次写入失败: %v", err)
	}
	if err := db.SetOfflineCache("pr:1", `{"a":2}`); err != nil {
		t.Fatalf("二次写入失败: %v", err)
	}
	got, _, _ := db.GetOfflineCache("pr:1", 0)
	if got.Payload != `{"a":2}` {
		t.Fatalf("同一个 key 应被覆盖，实际 %q", got.Payload)
	}
}

func TestOfflineCacheRejectsEmptyKey(t *testing.T) {
	db := openTestDB(t)
	if err := db.SetOfflineCache("", "x"); err == nil {
		t.Fatal("空 key 应被拒绝")
	}
}

func TestOfflineCacheMissIsNotAnError(t *testing.T) {
	db := openTestDB(t)
	_, ok, err := db.GetOfflineCache("never-written", 0)
	if err != nil {
		t.Fatalf("未命中不该是错误: %v", err)
	}
	if ok {
		t.Fatal("没写过的 key 不该命中")
	}
}

func TestOfflineCacheExpiresAndIsRemoved(t *testing.T) {
	db := openTestDB(t)
	if err := db.SetOfflineCache("stale", `{"old":true}`); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	// 把取回时间改成很久以前，模拟一条过期记录。
	if _, err := db.sql.Exec(
		`UPDATE offline_cache SET fetched_at = ? WHERE key = ?`,
		time.Now().Add(-48*time.Hour).Unix(), "stale",
	); err != nil {
		t.Fatalf("改时间失败: %v", err)
	}

	_, ok, err := db.GetOfflineCache("stale", time.Hour)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if ok {
		t.Fatal("超过 maxAge 的缓存不该命中")
	}

	// 顺手删掉了：再按不设期限读也应该是未命中。
	if _, ok, _ := db.GetOfflineCache("stale", 0); ok {
		t.Fatal("过期记录应被删除，而不是留在库里")
	}
}

func TestPruneOfflineCache(t *testing.T) {
	db := openTestDB(t)
	if err := db.SetOfflineCache("fresh", "x"); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := db.SetOfflineCache("old", "y"); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if _, err := db.sql.Exec(
		`UPDATE offline_cache SET fetched_at = ? WHERE key = ?`,
		time.Now().Add(-30*24*time.Hour).Unix(), "old",
	); err != nil {
		t.Fatalf("改时间失败: %v", err)
	}

	removed, err := db.PruneOfflineCache(7 * 24 * time.Hour)
	if err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	if removed != 1 {
		t.Fatalf("应删掉一条旧记录，实际 %d 条", removed)
	}
	if _, ok, _ := db.GetOfflineCache("fresh", 0); !ok {
		t.Fatal("新记录不该被删")
	}
	if _, ok, _ := db.GetOfflineCache("old", 0); ok {
		t.Fatal("旧记录应被删")
	}
}
