package git

import (
	"os/exec"
	"testing"
)

func TestParseGitVersion(t *testing.T) {
	cases := map[string]string{
		"git version 2.55.0.windows.5":          "2.55.0.windows.5",
		"git version 2.43.0":                    "2.43.0",
		"git version 2.39.5 (Apple Git-154)":    "2.39.5",
		"git version 2.34.1\n":                  "2.34.1",
		"git version 2.55.0.windows.5 (64-bit)": "2.55.0.windows.5",
	}
	for out, want := range cases {
		if got := parseGitVersion(out); got != want {
			t.Fatalf("parseGitVersion(%q) = %q，期望 %q", out, got, want)
		}
	}
}

// 版本探测要能真的跑起来：拿不到版本时返回 ErrGitMissing 而不是空串。
func TestVersionReturnsParsedVersion(t *testing.T) {
	needGit(t)
	v, err := Version()
	if err != nil {
		t.Fatalf("Version 失败: %v", err)
	}
	if v == "" {
		t.Fatal("版本号不该为空")
	}
	// 至少是 "2.x" 形态，而不是整行原文。
	out, _ := exec.Command("git", "--version").Output()
	if v == string(out) {
		t.Fatalf("版本号应当去掉前缀，得到: %q", v)
	}
}
