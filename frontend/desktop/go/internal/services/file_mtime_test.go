package services

import (
	"testing"
)

// jsMaxSafeInteger 是 JavaScript Number 能精确表示的最大整数。
//
// 绑定层把 Go 的 int64 交给 JS 时，超出这个范围的值会被静默舍入。
const jsMaxSafeInteger = 9007199254740991

// mtime 必须以毫秒为单位跨过绑定层。
//
// 曾经用纳秒（约 1.7e18），超过 JS 的安全整数范围，往返一次就被舍入，
// 于是**刚打开、没有任何外部改动的文件**也报冲突：保存永远失败，
// 而 Go 单测全绿（Go 侧 int64 无损）。这类缺陷只能靠守住单位来防。
func TestFileTextMtimeFitsJavaScriptSafeInteger(t *testing.T) {
	svc, id, _ := newFileService(t)

	text, err := svc.ReadText(id, "hello.txt")
	if err != nil {
		t.Fatalf("读文件失败: %v", err)
	}
	if text.Mtime > jsMaxSafeInteger {
		t.Errorf(
			"mtime %d 超过 JS 安全整数上限 %d：经绑定层往返会被舍入，冲突检测将永远失败",
			text.Mtime, jsMaxSafeInteger,
		)
	}

	stat, err := svc.StatText(id, "hello.txt")
	if err != nil {
		t.Fatalf("查询状态失败: %v", err)
	}
	if stat.Mtime > jsMaxSafeInteger {
		t.Errorf("StatText 的 mtime %d 超过 JS 安全整数上限", stat.Mtime)
	}
}

// 写回返回的新 mtime 同样要落在安全范围内。
func TestWriteTextReturnsSafeMtime(t *testing.T) {
	svc, id, _ := newFileService(t)

	newMtime, err := svc.WriteText(id, "hello.txt", "x\n", 0)
	if err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
	if newMtime > jsMaxSafeInteger {
		t.Errorf("写回后的 mtime %d 超过 JS 安全整数上限", newMtime)
	}
}

// 专门复现"读一次 → 立刻用同一个 mtime 写回"这条路径。
//
// 界面上报的是假冲突：文件刚读出来、没有外部改动，保存却被拒绝。
// 这里把最短路径单独钉住，确认问题在 Go 侧还是前端传参。
func TestWriteTextAcceptsMtimeJustRead(t *testing.T) {
	svc, id, _ := newFileService(t)

	text, err := svc.ReadText(id, "hello.txt")
	if err != nil {
		t.Fatalf("读文件失败: %v", err)
	}

	// 关键：用刚读到的 mtime 立刻写回，中间不做任何其他操作。
	if _, err := svc.WriteText(id, "hello.txt", text.Content+"more\n", text.Mtime); err != nil {
		t.Fatalf("刚读到的 mtime 应当能通过校验，实际: %v", err)
	}
}

// 同一文件读两次，mtime 必须稳定：这是"基准值"这个概念成立的前提。
func TestReadTextMtimeIsStable(t *testing.T) {
	svc, id, _ := newFileService(t)

	first, err := svc.ReadText(id, "hello.txt")
	if err != nil {
		t.Fatalf("第一次读失败: %v", err)
	}
	second, err := svc.ReadText(id, "hello.txt")
	if err != nil {
		t.Fatalf("第二次读失败: %v", err)
	}
	if first.Mtime != second.Mtime {
		t.Errorf("两次读到不同 mtime: %d vs %d", first.Mtime, second.Mtime)
	}
}
