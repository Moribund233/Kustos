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

// 工作副本按 path 唯一：同一个工作树被重复添加时应更新记录，而不是插第二行。
func TestSaveWorkingCopyUpsertsByPath(t *testing.T) {
	db := newTestDB(t)

	wc := WorkingCopy{
		ID:         "wc1",
		InstanceID: "inst1",
		RepoID:     42,
		Path:       "/home/u/src/kustos",
		Branch:     "main",
	}
	if err := db.SaveWorkingCopy(wc); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	wc.ID = "wc2"
	wc.Branch = "feature/x"
	wc.Dirty = true
	wc.Ahead = 2
	if err := db.SaveWorkingCopy(wc); err != nil {
		t.Fatalf("重复保存失败: %v", err)
	}

	list, err := db.ListWorkingCopies()
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("同一 path 应合并为一行，实际 %d 行", len(list))
	}
	if list[0].Branch != "feature/x" || !list[0].Dirty || list[0].Ahead != 2 {
		t.Fatalf("应被更新，实际 %+v", list[0])
	}
}

// 空列表返回空切片而非 nil：nil 会序列化成 JSON null，前端要多写判空分支。
func TestListWorkingCopiesReturnsEmptySlice(t *testing.T) {
	db := newTestDB(t)
	list, err := db.ListWorkingCopies()
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if list == nil {
		t.Fatal("应为空切片而非 nil")
	}
}

func TestWorkingCopyRequiresPathAndID(t *testing.T) {
	db := newTestDB(t)

	if err := db.SaveWorkingCopy(WorkingCopy{Path: "/x"}); err == nil {
		t.Error("缺 ID 应报错")
	}
	if err := db.SaveWorkingCopy(WorkingCopy{ID: "a"}); err == nil {
		t.Error("缺 Path 应报错")
	}
}

func TestGetWorkingCopyNotFound(t *testing.T) {
	db := newTestDB(t)
	wc, ok, err := db.GetWorkingCopy("nope")
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if ok {
		t.Fatalf("不应命中，实际 %+v", wc)
	}
}

func TestDeleteWorkingCopyRemovesRow(t *testing.T) {
	db := newTestDB(t)
	_ = db.SaveWorkingCopy(WorkingCopy{ID: "wc1", Path: "/a"})

	if err := db.DeleteWorkingCopy("wc1"); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if _, ok, _ := db.GetWorkingCopy("wc1"); ok {
		t.Fatal("删除后不应命中")
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

// 信任是"允不允许在这个目录里跑别人的代码"的唯一依据，读错方向就等于默认放行。
func TestSetWorkspaceTrustRoundTrip(t *testing.T) {
	db := newTestDB(t)

	if err := db.SetWorkspaceTrust(`D:\work\demo`, "https://example.invalid/acme/atlas.git", true); err != nil {
		t.Fatalf("写入信任失败: %v", err)
	}
	got, ok, err := db.GetWorkspaceTrust(`D:\work\demo`)
	if err != nil {
		t.Fatalf("读取信任失败: %v", err)
	}
	if !ok {
		t.Fatal("应当命中")
	}
	if !got.Trusted {
		t.Error("应当记成已信任")
	}
	if got.Origin != "https://example.invalid/acme/atlas.git" {
		t.Errorf("应当记下远端来源，实际 %q", got.Origin)
	}
	if got.DecidedAt == 0 {
		t.Error("应当记下决定时间")
	}
}

// 拒绝也是一种决定，必须能和"还没问过"区分开。
func TestSetWorkspaceTrustRecordsRejection(t *testing.T) {
	db := newTestDB(t)

	if err := db.SetWorkspaceTrust("/work/demo", "", false); err != nil {
		t.Fatalf("写入信任失败: %v", err)
	}
	got, ok, err := db.GetWorkspaceTrust("/work/demo")
	if err != nil {
		t.Fatalf("读取信任失败: %v", err)
	}
	if !ok {
		t.Fatal("拒绝也应当留下记录")
	}
	if got.Trusted {
		t.Error("应当记成未信任")
	}
}

func TestGetWorkspaceTrustMissing(t *testing.T) {
	db := newTestDB(t)

	_, ok, err := db.GetWorkspaceTrust("/work/never-asked")
	if err != nil {
		t.Fatalf("读取信任失败: %v", err)
	}
	if ok {
		t.Fatal("没有记录时不应命中")
	}
}

func TestSetWorkspaceTrustRequiresPath(t *testing.T) {
	db := newTestDB(t)
	if err := db.SetWorkspaceTrust("", "", true); err == nil {
		t.Fatal("空路径应当报错")
	}
}

func TestSetWorkspaceTrustOverwrites(t *testing.T) {
	db := newTestDB(t)

	if err := db.SetWorkspaceTrust("/work/demo", "https://example.invalid/a.git", true); err != nil {
		t.Fatalf("写入信任失败: %v", err)
	}
	if err := db.SetWorkspaceTrust("/work/demo", "https://example.invalid/b.git", false); err != nil {
		t.Fatalf("改写信任失败: %v", err)
	}
	got, ok, err := db.GetWorkspaceTrust("/work/demo")
	if err != nil {
		t.Fatalf("读取信任失败: %v", err)
	}
	if !ok || got.Trusted {
		t.Fatalf("应当被改成未信任，实际 %+v（命中 %v）", got, ok)
	}
	if got.Origin != "https://example.invalid/b.git" {
		t.Errorf("来源应当一起更新，实际 %q", got.Origin)
	}
}

func TestClearWorkspaceTrustRemovesDecision(t *testing.T) {
	db := newTestDB(t)

	if err := db.SetWorkspaceTrust("/work/demo", "", true); err != nil {
		t.Fatalf("写入信任失败: %v", err)
	}
	if err := db.ClearWorkspaceTrust("/work/demo"); err != nil {
		t.Fatalf("删除信任失败: %v", err)
	}
	if _, ok, _ := db.GetWorkspaceTrust("/work/demo"); ok {
		t.Fatal("删除后不应命中")
	}
}

// 远端换到别的仓库，旧点头不该顺延——代码出处变了，要重新问。
func TestWorkspaceTrustAppliesToRejectsOtherOrigin(t *testing.T) {
	trust := WorkspaceTrust{Origin: "https://example.invalid/a.git"}
	if trust.AppliesTo("https://example.invalid/b.git") {
		t.Error("换了远端不应继续适用")
	}
	if !trust.AppliesTo("https://example.invalid/a.git") {
		t.Error("同一个远端应当继续适用")
	}
}

// 任一侧为空都算来源未变：旧版记录没有来源，本地仓库也没有远端，
// 这两种都不该让用户重答一次。
func TestWorkspaceTrustAppliesToToleratesMissingOrigin(t *testing.T) {
	if !(WorkspaceTrust{}).AppliesTo("https://example.invalid/a.git") {
		t.Error("旧记录（无来源）应当继续适用")
	}
	if !(WorkspaceTrust{Origin: "https://example.invalid/a.git"}).AppliesTo("") {
		t.Error("远端被删掉时应当继续适用")
	}
	if !(WorkspaceTrust{}).AppliesTo("") {
		t.Error("两边都空应当适用")
	}
}
