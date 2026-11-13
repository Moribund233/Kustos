package shellreg

import "testing"

// 这两条命令行的引号位置是 Windows 协议处理器与 Run 键的既定写法。
// 少一个引号不会报错，只在"路径含空格"这类机器上静默失效——
// 而那恰好是最常见的安装路径，所以写成断言。

func TestProtocolCommandQuotesBothParts(t *testing.T) {
	got := ProtocolCommand(`C:\Program Files\Kustos\kustos-desktop.exe`)
	want := `"C:\Program Files\Kustos\kustos-desktop.exe" "%1"`
	if got != want {
		t.Fatalf("协议命令应为 %q，实际 %q", want, got)
	}
}

func TestAutostartCommandQuotesPath(t *testing.T) {
	got := AutostartCommand(`C:\Program Files\Kustos\kustos-desktop.exe`)
	want := `"C:\Program Files\Kustos\kustos-desktop.exe"`
	if got != want {
		t.Fatalf("自启命令应为 %q，实际 %q", want, got)
	}
}

func TestAutostartCommandHasNoPlaceholder(t *testing.T) {
	// 自启动不带深链占位符：带上去会变成一个没有意义的参数。
	got := AutostartCommand(`D:\app.exe`)
	if got != `"D:\app.exe"` {
		t.Fatalf("自启命令不该带参数，实际 %q", got)
	}
}

func TestSchemeIsKustos(t *testing.T) {
	if Scheme != "kustos" {
		t.Fatalf("协议名应与 deeplink 包一致，实际 %q", Scheme)
	}
}

func TestRunValueNameIsProductName(t *testing.T) {
	if RunValueName != "Kustos" {
		t.Fatalf("启动项名称应为产品名，实际 %q", RunValueName)
	}
}
