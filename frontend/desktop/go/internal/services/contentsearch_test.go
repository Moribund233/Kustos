package services

import (
	"strings"
	"testing"
)

// SearchContent：全文搜索的服务层入口。git 侧的解析与截断在 internal/git
// 里已覆盖，这里只测服务层自己的职责：工作副本解析、路径收敛、参数透传。

func TestSearchContentFindsMatches(t *testing.T) {
	svc, id, dir := newCodeFixture(t)
	writeFile(t, dir, "src/lib/caret.ts", "export function caretFor(name: string) {\n  return name;\n}\n")
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "-m", "more")

	res, err := svc.SearchContent(id, ContentSearchQuery{Query: "caretFor"})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(res.Matches) != 1 {
		t.Fatalf("应命中 1 行，实际 %+v", res.Matches)
	}
	m := res.Matches[0]
	if m.Path != "src/lib/caret.ts" || m.Line != 1 {
		t.Errorf("命中位置不对: %+v", m)
	}
	if !strings.Contains(m.Text, "export function") {
		t.Errorf("命中应带整行内容: %q", m.Text)
	}
}

// 目录前缀越界必须拒绝：路径是前端传来的字符串。
func TestSearchContentRejectsEscapingPath(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	for _, bad := range []string{"../", "../../etc", "/etc", "..\\.."} {
		if _, err := svc.SearchContent(id, ContentSearchQuery{Query: "x", Path: bad}); err == nil {
			t.Errorf("越界目录 %q 应被拒绝", bad)
		}
	}
}

// 不存在的目录前缀报错而不是空结果：那多半是界面拿着旧的展开状态，
// "仓库里没有这个内容"与"这个目录不存在"是两回事。
func TestSearchContentMissingPathScope(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	if _, err := svc.SearchContent(id, ContentSearchQuery{Query: "x", Path: "nope/"}); err == nil {
		t.Fatal("不存在的目录应报错")
	}
}

func TestSearchContentEmptyQueryReturnsNothing(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	res, err := svc.SearchContent(id, ContentSearchQuery{Query: "  "})
	if err != nil {
		t.Fatalf("空查询不应报错: %v", err)
	}
	if len(res.Matches) != 0 {
		t.Fatalf("空查询应返回空结果: %+v", res.Matches)
	}
}

// 非法正则要报错：空结果会让用户以为"仓库里没有"，实际是表达式写错了。
func TestSearchContentInvalidRegex(t *testing.T) {
	svc, id, _ := newCodeFixture(t)

	if _, err := svc.SearchContent(id, ContentSearchQuery{Query: "([oops", Regex: true}); err == nil {
		t.Fatal("非法正则应报错")
	}
}

func TestSearchContentUnknownIDFails(t *testing.T) {
	svc, _, _ := newCodeFixture(t)

	if _, err := svc.SearchContent("no-such-id", ContentSearchQuery{Query: "x"}); err == nil {
		t.Fatal("未知工作副本应报错")
	}
}
