package singleinstance

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// 单实例的关键约束是"两次启动必须算出同一个密钥"：
// 若密钥每次随机，第二实例加密的数据第一实例解不开，参数会被静默丢弃，
// 表现为"双击图标没反应"——这类缺陷极难从现象反推原因，因此写成断言。

func TestEncryptionKeyIsStableAcrossCalls(t *testing.T) {
	first := encryptionKey()
	second := encryptionKey()

	if first != second {
		t.Fatal("密钥必须稳定：否则第二实例传递的参数第一实例无法解密")
	}
}

func TestEncryptionKeyIsNotZero(t *testing.T) {
	var zero [32]byte
	if encryptionKey() == zero {
		t.Fatal("密钥不能为全零：全零在 Wails 里表示不加密")
	}
}

func TestOptionsWiresUniqueIDAndKey(t *testing.T) {
	opts := Options(func(_ application.SecondInstanceData) {})

	if opts.UniqueID != UniqueID {
		t.Fatalf("UniqueID 应为 %q，实际 %q", UniqueID, opts.UniqueID)
	}
	if opts.ExitCode != ExitCode {
		t.Fatalf("ExitCode 应为 %d，实际 %d", ExitCode, opts.ExitCode)
	}
	if opts.EncryptionKey != encryptionKey() {
		t.Fatal("Options 必须使用同一个固定密钥")
	}
	if opts.OnSecondInstanceLaunch == nil {
		t.Fatal("回调必须被接上，否则第二实例启动时没有任何响应")
	}
}

func TestShouldIgnoreArgs(t *testing.T) {
	// 只有程序自身路径：本次启动没有任何需要转交的意图。
	if !ShouldIgnoreArgs([]string{"kustos-desktop.exe"}) {
		t.Error("无附加参数时应忽略")
	}
	if !ShouldIgnoreArgs(nil) {
		t.Error("空参数应忽略")
	}
	// 带参数的启动仍需由调用方决定如何处理，这里不声称已支持。
	if ShouldIgnoreArgs([]string{"kustos-desktop.exe", "kustos://repo/1"}) {
		t.Error("带参数时不应声称可忽略")
	}
}
