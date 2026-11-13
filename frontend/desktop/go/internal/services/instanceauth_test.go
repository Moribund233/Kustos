package services

import (
	"testing"
)

// instanceauth.go 的出口：它回答"此刻登录着哪个实例"，三条联网链路共用。

// networkAuth 是 push/fetch 唯一的凭据入口：半个凭据（有地址没令牌，或
// 反过来）一律当没有，否则会注入出一枚注定失败的 Authorization 头。
func TestNetworkAuthRequiresBothHalves(t *testing.T) {
	svc := newTestWorkingCopyService(t)

	cases := []struct {
		name string
		auth InstanceAuth
		want bool
	}{
		{"完整", InstanceAuth{BaseURL: "https://git.example.com", Token: "tok"}, true},
		{"未登录", InstanceAuth{BaseURL: "https://git.example.com", Token: ""}, false},
		{"没连实例", InstanceAuth{BaseURL: "", Token: "tok"}, false},
		{"只有空白", InstanceAuth{BaseURL: "  ", Token: "  "}, false},
		{"什么都没接", InstanceAuth{}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			auth := tc.auth
			BindInstanceAuth(func() InstanceAuth { return auth })
			t.Cleanup(func() { BindInstanceAuth(nil) })

			got := svc.networkAuth()
			if (got != nil) != tc.want {
				t.Fatalf("是否给出凭据 = %v，期望 %v", got != nil, tc.want)
			}
			if got != nil && *got != auth {
				t.Fatalf("应当原样传下去，得到 %+v", *got)
			}
		})
	}
}

// 没接线（装配层之外的测试环境）时不能 panic，也不能编造凭据。
func TestNetworkAuthWithoutProvider(t *testing.T) {
	svc := newTestWorkingCopyService(t)
	BindInstanceAuth(nil)

	if got := svc.networkAuth(); got != nil {
		t.Fatalf("未接线时不该有凭据，得到 %+v", *got)
	}
}

// 凭据现取而不是缓存：一次 push 前令牌可能已经换了。
func TestNetworkAuthReadsProviderEveryCall(t *testing.T) {
	svc := newTestWorkingCopyService(t)

	var token string
	BindInstanceAuth(func() InstanceAuth { return InstanceAuth{BaseURL: "https://git.example.com", Token: token} })
	t.Cleanup(func() { BindInstanceAuth(nil) })

	token = "first"
	if got := svc.networkAuth(); got == nil || got.Token != "first" {
		t.Fatalf("第一次应当读到 first，得到 %+v", got)
	}
	token = "rotated"
	if got := svc.networkAuth(); got == nil || got.Token != "rotated" {
		t.Fatalf("第二次应当读到换发后的令牌，得到 %+v", got)
	}
}
