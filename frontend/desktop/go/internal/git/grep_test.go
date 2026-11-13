package git

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newBufReader 是测试里喂给 readGrepRecord 的小工具。
func newBufReader(s string) *bufio.Reader {
	return bufio.NewReader(strings.NewReader(s))
}

// GrepContent 的测试用真实仓库：这个包的全部价值在与终端行为一致，
// mock 掉 git 输出等于测自己的想象。

func TestGrepContentFindsTrackedFiles(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "src/app.ts", "export const demoValue = 1;\nother line\n")
	write(t, dir, "README.md", "# Demo Title\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	res, err := GrepContent(dir, GrepRequest{Query: "demo"})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	// 默认大小写不敏感：两处都应命中。
	if len(res.Matches) != 2 {
		t.Fatalf("应命中 2 行，实际 %d: %+v", len(res.Matches), res.Matches)
	}
	byPath := map[string]ContentMatch{}
	for _, m := range res.Matches {
		byPath[m.Path] = m
	}
	if m, ok := byPath["README.md"]; !ok || m.Line != 1 || !strings.Contains(m.Text, "Demo Title") {
		t.Errorf("README 命中不对: %+v", m)
	}
	if m, ok := byPath["src/app.ts"]; !ok || m.Line != 1 {
		t.Errorf("src/app.ts 命中不对: %+v", m)
	}
}

// 未跟踪但不被忽略的文件也要能搜到：刚新建的文件是搜索最高频的对象。
func TestGrepContentIncludesUntracked(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "seed\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")
	write(t, dir, "new.go", "package main // needleHere\n")

	res, err := GrepContent(dir, GrepRequest{Query: "needleHere"})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(res.Matches) != 1 || res.Matches[0].Path != "new.go" {
		t.Fatalf("未跟踪文件应命中: %+v", res.Matches)
	}
}

// 被 .gitignore 忽略的文件不搜：与终端里 git grep 的行为一致，
// 也让构建产物、依赖目录不会污染结果。
func TestGrepContentSkipsIgnored(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, ".gitignore", "ignored.txt\n")
	write(t, dir, "a.txt", "seed\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")
	write(t, dir, "ignored.txt", "needleIgnored\n")

	res, err := GrepContent(dir, GrepRequest{Query: "needleIgnored"})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(res.Matches) != 0 {
		t.Fatalf("被忽略的文件不应命中: %+v", res.Matches)
	}
}

func TestGrepContentCaseSensitiveOption(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "Demo demo DEMO\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	insensitive, err := GrepContent(dir, GrepRequest{Query: "demo"})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(insensitive.Matches) != 1 {
		t.Fatalf("一行里三个大小写变体应算一条命中: %+v", insensitive.Matches)
	}

	sensitive, err := GrepContent(dir, GrepRequest{Query: "DEMO", CaseSensitive: true})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(sensitive.Matches) != 1 || !strings.Contains(sensitive.Matches[0].Text, "DEMO") {
		t.Fatalf("区分大小写应只命中 DEMO: %+v", sensitive.Matches)
	}
}

// 默认按字面量匹配：用户输入 `fn(x)` 时不应该被当成正则而匹配不到。
func TestGrepContentLiteralByDefault(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "call fn(x) here\nfnpx too\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	literal, err := GrepContent(dir, GrepRequest{Query: "fn(x)"})
	if err != nil {
		t.Fatalf("字面量搜索失败: %v", err)
	}
	if len(literal.Matches) != 1 || !strings.Contains(literal.Matches[0].Text, "fn(x)") {
		t.Fatalf("应命中字面量 fn(x): %+v", literal.Matches)
	}

	regex, err := GrepContent(dir, GrepRequest{Query: "fn.x", Regex: true})
	if err != nil {
		t.Fatalf("正则搜索失败: %v", err)
	}
	// `fn.x` 同时命中字面量 "fn(x)" 里的 fn(x 与 "fnpx"。
	if len(regex.Matches) != 2 {
		t.Fatalf("正则 fn.x 应命中两行: %+v", regex.Matches)
	}
}

// 非法正则是用户输入的常态，要报错而不是空结果——空结果意味着
// "这个仓库里没有"，而实际是"你的表达式写错了"。
func TestGrepContentInvalidRegexFails(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "x\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	if _, err := GrepContent(dir, GrepRequest{Query: "([unclosed", Regex: true}); err == nil {
		t.Fatal("非法正则应报错")
	}
}

func TestGrepContentPathScope(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "src/a.ts", "sharedToken\n")
	write(t, dir, "docs/b.md", "sharedToken\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	res, err := GrepContent(dir, GrepRequest{Query: "sharedToken", Path: "src"})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(res.Matches) != 1 || res.Matches[0].Path != "src/a.ts" {
		t.Fatalf("限定 src 后只应命中 src/a.ts: %+v", res.Matches)
	}
}

func TestGrepContentTotalLimitTruncates(t *testing.T) {
	dir := newRepo(t)
	var b strings.Builder
	for i := 0; i < 40; i++ {
		b.WriteString("hit line\n")
	}
	write(t, dir, "many.txt", b.String())
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	res, err := GrepContent(dir, GrepRequest{Query: "hit line", MaxMatches: 5})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(res.Matches) != 5 {
		t.Fatalf("应截断到 5 条，实际 %d", len(res.Matches))
	}
	if !res.Truncated {
		t.Error("触到上限应标记 Truncated")
	}

	full, err := GrepContent(dir, GrepRequest{Query: "hit line", MaxMatches: 100})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if full.Truncated {
		t.Error("没有超限时不应标记截断")
	}
}

// 逐文件上限保证一个"哪都命中"的文件不会吃光配额。
func TestGrepContentPerFileCapLetsOtherFilesShow(t *testing.T) {
	dir := newRepo(t)
	var b strings.Builder
	for i := 0; i < grepPerFileLimit+20; i++ {
		b.WriteString("ubiquitous\n")
	}
	write(t, dir, "aaa-huge.txt", b.String())
	write(t, dir, "zzz-small.txt", "ubiquitous once\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	res, err := GrepContent(dir, GrepRequest{Query: "ubiquitous", MaxMatches: 200})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	found := false
	for _, m := range res.Matches {
		if m.Path == "zzz-small.txt" {
			found = true
		}
	}
	if !found {
		t.Fatal("大文件不应挤掉其他文件的命中")
	}
}

func TestGrepContentNoMatchesIsNotError(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "hello\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	res, err := GrepContent(dir, GrepRequest{Query: "definitely_not_here"})
	if err != nil {
		t.Fatalf("没有命中不应报错: %v", err)
	}
	if len(res.Matches) != 0 || res.Truncated {
		t.Fatalf("应返回空结果: %+v", res)
	}
}

func TestGrepContentEmptyQueryReturnsNothing(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "x\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	res, err := GrepContent(dir, GrepRequest{Query: "   "})
	if err != nil {
		t.Fatalf("空查询不应报错: %v", err)
	}
	if len(res.Matches) != 0 {
		t.Fatalf("空查询应返回空结果，实际 %d", len(res.Matches))
	}
}

// 以 `-` 开头的查询必须还能搜：靠 -e 显式标记查询起点。
func TestGrepContentQueryStartingWithDash(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "flags.txt", "--dry-run flag\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	res, err := GrepContent(dir, GrepRequest{Query: "--dry-run"})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(res.Matches) != 1 {
		t.Fatalf("应命中 --dry-run: %+v", res.Matches)
	}
}

// 二进制文件不参与：含 NUL 的内容行对搜索没有意义，还可能一次吐几 KB 乱码。
func TestGrepContentSkipsBinary(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "a.txt", "seed\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")
	if err := os.WriteFile(filepath.Join(dir, "blob.bin"), []byte{0, 1, 'N', 'E', 'E', 'D', 0, 2}, 0o644); err != nil {
		t.Fatalf("写二进制失败: %v", err)
	}

	res, err := GrepContent(dir, GrepRequest{Query: "NEED", CaseSensitive: true})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(res.Matches) != 0 {
		t.Fatalf("二进制内容不应命中: %+v", res.Matches)
	}
}

// 路径含空格的记录要能按 NUL 正确切开（这是 -z 的全部意义）。
func TestGrepContentPathWithSpaces(t *testing.T) {
	dir := newRepo(t)
	write(t, dir, "my docs/read me.md", "needleSpaced\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "init")

	res, err := GrepContent(dir, GrepRequest{Query: "needleSpaced"})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(res.Matches) != 1 || res.Matches[0].Path != "my docs/read me.md" {
		t.Fatalf("带空格路径应完整还原: %+v", res.Matches)
	}
}

/* ------------------------------------------------------------------ */
/* 解析器纯逻辑                                                        */
/* ------------------------------------------------------------------ */

func TestReadGrepRecordParsesFields(t *testing.T) {
	// 实测格式：path\0line\0text\n（文本以换行结尾，没有闭合 NUL）。
	m, ok, err := readGrepRecord(newBufReader("src/a.ts\x0042\x00const x = 1;\n"))
	if err != nil || !ok {
		t.Fatalf("解析失败 ok=%v err=%v", ok, err)
	}
	if m.Path != "src/a.ts" || m.Line != 42 || m.Text != "const x = 1;" {
		t.Fatalf("第一条解析不对: %+v", m)
	}
	m2, ok, err := readGrepRecord(newBufReader("README.md\x001\x00# Title\r\n"))
	if err != nil || !ok {
		t.Fatalf("解析失败 ok=%v err=%v", ok, err)
	}
	if m2.Path != "README.md" || m2.Line != 1 || m2.Text != "# Title" {
		t.Fatalf("第二条解析不对（CRLF 应裁掉）: %+v", m2)
	}
	// 末行没有换行的文件：git 输出也不带行尾，仍是一条有效记录。
	m3, ok, err := readGrepRecord(newBufReader("last.txt\x007\x00no trailing newline"))
	if err != nil || !ok {
		t.Fatalf("无行尾的记录应有效 ok=%v err=%v", ok, err)
	}
	if m3.Path != "last.txt" || m3.Line != 7 || m3.Text != "no trailing newline" {
		t.Fatalf("无行尾记录解析不对: %+v", m3)
	}
}

func TestReadGrepRecordRejectsTruncatedTail(t *testing.T) {
	// 进程被杀时最后一条可能只写了一半：有路径但没有行号。
	if _, ok, err := readGrepRecord(newBufReader("a.txt\x00")); ok || err == nil {
		t.Fatalf("半截记录应被拒绝")
	}
	// 完全空输入是正常到头，不是错误。
	if _, ok, err := readGrepRecord(newBufReader("")); ok || err != nil {
		t.Fatalf("空输入应安静到头 ok=%v err=%v", ok, err)
	}
}
