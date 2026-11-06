package store

import (
	"os"
	"path/filepath"
	"testing"
)

// 用真实文件而不是 :memory:，覆盖 WAL、迁移事务与路径处理。
func TestOpenRealFileWithWAL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")

	db, err := Open(path)
	if err != nil {
		t.Fatalf("打开真实文件失败: %v", err)
	}
	defer func() { _ = db.Close() }()

	if err := db.SaveInstance(Instance{ID: "x", BaseURL: "https://a.example"}); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	list, _ := db.ListInstances()
	if len(list) != 1 {
		t.Fatalf("应有 1 行，实际 %d", len(list))
	}

	// WAL 模式会生成 -wal/-shm，确认真的启用了 WAL。
	if _, err := os.Stat(path + "-wal"); err != nil {
		t.Error("应生成 -wal 文件（WAL 模式）")
	}

	// 重开后数据仍在（验证迁移幂等 + 持久化）。
	_ = db.Close()
	db2, err := Open(path)
	if err != nil {
		t.Fatalf("重开失败: %v", err)
	}
	defer func() { _ = db2.Close() }()
	list2, _ := db2.ListInstances()
	if len(list2) != 1 {
		t.Fatalf("重开后应仍有 1 行，实际 %d", len(list2))
	}
}
