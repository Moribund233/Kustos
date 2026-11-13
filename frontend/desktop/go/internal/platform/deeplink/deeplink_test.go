package deeplink

import "testing"

// 深链是跨信任边界的输入：任何本机进程都能伪造一条。
// 因此这里的重点是"不合法的一律拒绝"，而不是"尽量猜出用户想要什么"。

func TestParseSurface(t *testing.T) {
	for _, surface := range []string{"inbox", "working-copy", "code", "pulls", "issues"} {
		target, err := Parse("kustos://" + surface)
		if err != nil {
			t.Fatalf("kustos://%s 应当可解析: %v", surface, err)
		}
		if target.Surface != surface {
			t.Fatalf("分区应为 %q，实际 %q", surface, target.Surface)
		}
		if target.Review != "" {
			t.Fatalf("分区深链不该带评审目标，实际 %q", target.Review)
		}
	}
}

func TestParseReview(t *testing.T) {
	target, err := Parse("kustos://review/01abc-def|42")
	if err != nil {
		t.Fatalf("评审深链应当可解析: %v", err)
	}
	if target.Surface != "pulls" {
		t.Fatalf("评审深链要落在 PR 面，实际 %q", target.Surface)
	}
	if target.Review != "01abc-def|42" {
		t.Fatalf("评审目标应为 01abc-def|42，实际 %q", target.Review)
	}
}

func TestParseReviewAcceptsEscapedSeparator(t *testing.T) {
	// 有些调用方会把 `|` 百分号编码，两种写法必须等价。
	target, err := Parse("kustos://review/01abc%7C7")
	if err != nil {
		t.Fatalf("编码过的分隔符应当可解析: %v", err)
	}
	if target.Review != "01abc|7" {
		t.Fatalf("评审目标应为 01abc|7，实际 %q", target.Review)
	}
}

func TestParseRejects(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"空串", ""},
		{"只有空白", "   "},
		{"协议不对", "https://code"},
		{"没有协议", "code"},
		{"首段像主机但不是已知目标", "kustos://evil.example/code"},
		{"未知分区", "kustos://settings"},
		{"分区多余路径", "kustos://code/extra"},
		{"缺少目标", "kustos://"},
		{"查询串", "kustos://code?x=1"},
		{"片段", "kustos://code#/review"},
		{"评审缺编号", "kustos://review/01abc"},
		{"评审编号非数字", "kustos://review/01abc|abc"},
		{"评审编号为零", "kustos://review/01abc|0"},
		{"评审编号为负", "kustos://review/01abc|-3"},
		{"评审缺仓库 id", "kustos://review/|42"},
		{"评审多余段", "kustos://review/01abc|42/extra"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Parse(tc.raw); err == nil {
				t.Fatalf("%q 应当被拒绝", tc.raw)
			}
		})
	}
}

func TestParseTrimsWhitespace(t *testing.T) {
	// 命令行传来的参数常带引号外的空白，剥掉即可，不该因此拒绝。
	if _, err := Parse("  kustos://code  "); err != nil {
		t.Fatalf("带首尾空白应当可解析: %v", err)
	}
}

// FindInArgs 从一组命令行参数里挑出第一条深链。
func TestFindInArgs(t *testing.T) {
	got, ok := FindInArgs([]string{"kustos-desktop.exe", "--x", "kustos://code"})
	if !ok || got != "kustos://code" {
		t.Fatalf("应挑出深链，实际 %q %v", got, ok)
	}

	if _, ok := FindInArgs([]string{"kustos-desktop.exe"}); ok {
		t.Fatal("没有深链时不该声称找到")
	}
	if _, ok := FindInArgs(nil); ok {
		t.Fatal("空参数不该声称找到")
	}
	// 第一个参数是程序自身路径，即使它长得像深链也不能被当成用户意图。
	if _, ok := FindInArgs([]string{"kustos://code"}); ok {
		t.Fatal("程序路径本身不该被当成深链")
	}
}
