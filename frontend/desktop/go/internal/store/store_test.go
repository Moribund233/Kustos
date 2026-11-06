package store

import "testing"

// 本地库的几个容易出错的点：upsert 语义、空切片 vs nil、迁移幂等。

func newTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestListInstancesReturnsEmptySliceNotNil(t *testing.T) {
	db := newTestDB(t)
	list, err := db.ListInstances()
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	// nil 会被序列化成 JSON null，前端就得多写一个判空分支。
	if list == nil {
		t.Fatal("空结果应为空切片而非 nil")
	}
	if len(list) != 0 {
		t.Fatalf("应为空，实际 %d", len(list))
	}
}

func TestSaveAndListInstance(t *testing.T) {
	db := newTestDB(t)

	if err := db.SaveInstance(Instance{
		ID: "i1", BaseURL: "https://kustos.example.com", Name: "公司实例", Version: "1.0.0",
	}); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	list, err := db.ListInstances()
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if len(list) != 1 || list[0].Name != "公司实例" {
		t.Fatalf("读到 %+v", list)
	}
	if list[0].CreatedAt == 0 {
		t.Error("CreatedAt 应自动填充")
	}
}

// 同一 base_url 重复添加应更新而不是插入第二行，
// 否则切换器里会出现两个相同条目。
func TestSaveInstanceUpsertsByBaseURL(t *testing.T) {
	db := newTestDB(t)

	_ = db.SaveInstance(Instance{ID: "i1", BaseURL: "https://a.example", Name: "旧名", Version: "1"})
	_ = db.SaveInstance(Instance{ID: "i2", BaseURL: "https://a.example", Name: "新名", Version: "2"})

	list, _ := db.ListInstances()
	if len(list) != 1 {
		t.Fatalf("重复 base_url 应合并为一行，实际 %d 行", len(list))
	}
	if list[0].Name != "新名" || list[0].Version != "2" {
		t.Fatalf("应被更新，实际 %+v", list[0])
	}
}

func TestSaveInstanceRequiresID(t *testing.T) {
	db := newTestDB(t)
	if err := db.SaveInstance(Instance{BaseURL: "https://x"}); err == nil {
		t.Fatal("缺 ID 应报错")
	}
}

func TestGetInstanceNotFound(t *testing.T) {
	db := newTestDB(t)
	it, ok, err := db.GetInstance("nope")
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if ok {
		t.Fatalf("不应命中，实际 %+v", it)
	}
}

func TestDeleteInstance(t *testing.T) {
	db := newTestDB(t)
	_ = db.SaveInstance(Instance{ID: "i1", BaseURL: "https://a.example"})

	if err := db.DeleteInstance("i1"); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	list, _ := db.ListInstances()
	if len(list) != 0 {
		t.Fatalf("删除后应为空，实际 %d", len(list))
	}
}

// 按 base_url 读回：保存后必须能拿到库里真正生效的那一行。
//
// upsert 按 base_url 冲突时保留原有 id，因此"我传进去的 id"未必是
// "库里最终那一行的 id"，调用方不能拿前者当后者用。
func TestGetInstanceByBaseURLReturnsPersistedRow(t *testing.T) {
	db := newTestDB(t)

	// 先用手工 id 存一行，再用另一个 id 存同一地址（触发 upsert 冲突）。
	if err := db.SaveInstance(Instance{ID: "manual", BaseURL: "https://a.example", Name: "旧"}); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	if err := db.SaveInstance(Instance{ID: "derived", BaseURL: "https://a.example", Name: "新"}); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	got, ok, err := db.GetInstanceByBaseURL("https://a.example")
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if !ok {
		t.Fatal("应命中")
	}
	if got.ID != "manual" {
		t.Fatalf("冲突时应保留原有 id，实际 %q", got.ID)
	}
	if got.Name != "新" {
		t.Fatalf("其余字段应被更新，实际 %q", got.Name)
	}
}

func TestGetInstanceByBaseURLNotFound(t *testing.T) {
	db := newTestDB(t)
	_, ok, err := db.GetInstanceByBaseURL("https://nope.example")
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if ok {
		t.Fatal("不应命中")
	}
}

// UI 状态按 key 覆盖写：同一个 key 再存一次应更新而不是插入第二行。
func TestSetUIStateOverwrites(t *testing.T) {
	db := newTestDB(t)

	if err := db.SetUIState("window.main", `{"width":1440}`); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := db.SetUIState("window.main", `{"width":1920}`); err != nil {
		t.Fatalf("覆盖写失败: %v", err)
	}

	raw, ok, err := db.GetUIState("window.main")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if !ok {
		t.Fatal("应命中")
	}
	if raw != `{"width":1920}` {
		t.Fatalf("应取最后一次写入，实际 %q", raw)
	}
}

func TestGetUIStateMissing(t *testing.T) {
	db := newTestDB(t)
	raw, ok, err := db.GetUIState("nope")
	if err != nil {
		t.Fatalf("缺失不应报错: %v", err)
	}
	if ok {
		t.Fatalf("不应命中，实际 %q", raw)
	}
	if raw != "" {
		t.Fatalf("缺失时值应为空串，实际 %q", raw)
	}
}

// 迁移必须幂等：重开同一个库不能重复建表或失败。
func TestMigrateIsIdempotent(t *testing.T) {
	db := newTestDB(t)
	if err := db.migrate(); err != nil {
		t.Fatalf("重复迁移失败: %v", err)
	}
	if err := db.migrate(); err != nil {
		t.Fatalf("重复迁移失败: %v", err)
	}
}
