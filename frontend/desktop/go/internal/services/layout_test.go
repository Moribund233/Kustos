package services

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// 服务层这一层只做两件事：把 internal 结构体翻译成扁平 DTO，
// 以及拒绝挂在不存在的工作副本上的布局。测试也就只盯这两件。

func TestSaveAndLoadCodeLayout(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	want := CodeLayout{
		WorkingCopyID: id,
		Tabs:          []string{"src/lib/client.ts", "README.md"},
		ActivePath:    "src/lib/client.ts",
		Expanded:      []string{"src", "src/lib"},
	}
	if err := svc.SaveCodeLayout(want); err != nil {
		t.Fatalf("保存布局失败: %v", err)
	}

	got, err := svc.LoadCodeLayout()
	if err != nil {
		t.Fatalf("读取布局失败: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("往返不一致: 期望 %+v，实际 %+v", want, got)
	}
}

// 首次打开时没有布局，前端要能拿到一个可判断的空值而不是错误。
func TestLoadCodeLayoutWhenEmpty(t *testing.T) {
	svc, _, _ := newCodeFixture(t)

	got, err := svc.LoadCodeLayout()
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if len(got.Tabs) != 0 || got.WorkingCopyID != "" {
		t.Fatalf("应为空布局，实际 %+v", got)
	}
}

// 已删除的工作副本不该继续产出布局记录，否则库里会攒下永远读不到的键。
func TestSaveCodeLayoutRejectsUnknownWorkingCopy(t *testing.T) {
	svc, _, _ := newCodeFixture(t)

	err := svc.SaveCodeLayout(CodeLayout{
		WorkingCopyID: "does-not-exist",
		Tabs:          []string{"README.md"},
		ActivePath:    "README.md",
	})
	if err == nil {
		t.Fatal("不存在的工作副本应报错")
	}
}

// 工作树被删掉（用户直接 rm -rf）后同样拒绝：恢复出来的标签点开只会全是错误。
func TestSaveCodeLayoutRejectsMissingWorktree(t *testing.T) {
	svc, id, dir := newCodeFixture(t)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("删除工作树失败: %v", err)
	}

	err := svc.SaveCodeLayout(CodeLayout{
		WorkingCopyID: id,
		Tabs:          []string{"README.md"},
		ActivePath:    "README.md",
	})
	if err == nil {
		t.Fatal("工作树不存在时应报错")
	}
}

// DTO 是前端能看到的形状，字段名变了 TS 侧就跟着变。
func TestCodeLayoutJSONShape(t *testing.T) {
	layout := CodeLayout{
		WorkingCopyID: "abc",
		Tabs:          []string{"a.ts"},
		ActivePath:    "a.ts",
		Expanded:      []string{"src"},
	}

	raw, err := json.Marshal(layout)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}

	want := `{"workingCopyId":"abc","tabs":["a.ts"],"activePath":"a.ts","expanded":["src"]}`
	if string(raw) != want {
		t.Fatalf("字段名不符: 期望 %s，实际 %s", want, raw)
	}
}
