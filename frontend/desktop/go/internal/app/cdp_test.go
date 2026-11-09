package app

import (
	"testing"
)

// 远程调试端口的开关必须默认关闭，且不能被一个笔误变成"开着"。
// 这条边界值得测：它决定分发给团队成员的产物里有没有一条"谁都连得上
// 渲染进程"的路。

func TestDebugCDPDisabledByDefault(t *testing.T) {
	t.Setenv(cdpEnvVar, "")

	if got := debugCDPPort(); got != 0 {
		t.Fatalf("默认应关闭远程调试，实际端口 %d", got)
	}
	if args := browserArgs(); args != nil {
		t.Fatalf("未启用时不应附加任何浏览器参数，实际 %v", args)
	}
}

func TestDebugCDPEnabledByEnv(t *testing.T) {
	t.Setenv(cdpEnvVar, "9222")

	if got := debugCDPPort(); got != 9222 {
		t.Fatalf("应返回 9222，实际 %d", got)
	}
	args := browserArgs()
	if len(args) != 1 || args[0] != "--remote-debugging-port=9222" {
		t.Fatalf("参数不对: %v", args)
	}
}

// 非法取值一律视为关闭：一个写错的端口不该让应用启动失败，
// 更不该退回到某个默认端口上悄悄开着。
func TestDebugCDPRejectsInvalidValues(t *testing.T) {
	for _, raw := range []string{"abc", "0", "-1", "65536", "99999", "  ", "9222abc"} {
		t.Run(raw, func(t *testing.T) {
			t.Setenv(cdpEnvVar, raw)
			if got := debugCDPPort(); got != 0 {
				t.Fatalf("%q 应被拒绝，实际返回 %d", raw, got)
			}
			if args := browserArgs(); args != nil {
				t.Fatalf("%q 不应产生参数，实际 %v", raw, args)
			}
		})
	}
}

func TestDebugCDPAcceptsBoundaryPorts(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want int
	}{
		{"1", 1},
		{"65535", 65535},
		{" 9222 ", 9222},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			t.Setenv(cdpEnvVar, tc.raw)
			if got := debugCDPPort(); got != tc.want {
				t.Fatalf("%q 应解析为 %d，实际 %d", tc.raw, tc.want, got)
			}
		})
	}
}
