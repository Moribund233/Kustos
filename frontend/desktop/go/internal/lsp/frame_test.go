package lsp

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

// 这组用例保护的是"帧边界"这一件事。LSP 消息体里可以带换行（多行 diff、
// 格式化后的 JSON），一旦按行解析，第一条多行消息就会让后续所有消息错位，
// 而且服务端不会报错——只是永远不再回话。这种故障在界面上表现为"补全偶尔
// 不灵"，极难归因，所以边界的正确性值得单独测。

func TestWriteFrameProducesContentLengthHeader(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, []byte(`{"jsonrpc":"2.0"}`)); err != nil {
		t.Fatalf("写帧失败: %v", err)
	}
	want := "Content-Length: 17\r\n\r\n{\"jsonrpc\":\"2.0\"}"
	if got := buf.String(); got != want {
		t.Errorf("帧格式不对\n实际 %q\n期望 %q", got, want)
	}
}

func TestWriteFrameRejectsEmptyBody(t *testing.T) {
	if err := WriteFrame(&bytes.Buffer{}, nil); err == nil {
		t.Fatal("空消息体应报错")
	}
}

func TestReadFrameRoundTrip(t *testing.T) {
	// 消息体里带换行：按行解析在这一步就会错。
	body := []byte("{\n  \"method\": \"textDocument/publishDiagnostics\"\n}")
	var wire bytes.Buffer
	if err := WriteFrame(&wire, body); err != nil {
		t.Fatalf("写帧失败: %v", err)
	}
	got, err := ReadFrame(bufio.NewReader(&wire))
	if err != nil {
		t.Fatalf("读帧失败: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("消息体不一致\n实际 %q\n期望 %q", got, body)
	}
}

func TestReadFrameReadsConsecutiveFrames(t *testing.T) {
	var wire bytes.Buffer
	_ = WriteFrame(&wire, []byte(`{"id":1}`))
	_ = WriteFrame(&wire, []byte(`{"id":2}`))

	r := bufio.NewReader(&wire)
	for _, want := range []string{`{"id":1}`, `{"id":2}`} {
		got, err := ReadFrame(r)
		if err != nil {
			t.Fatalf("读帧失败: %v", err)
		}
		if string(got) != want {
			t.Errorf("消息体不一致\n实际 %q\n期望 %q", got, want)
		}
	}
	// 第三帧应当干净地报流末尾，而不是挂住或返回空帧。
	if _, err := ReadFrame(r); err == nil {
		t.Error("流结束后应返回错误")
	}
}

func TestReadFrameIgnoresExtraHeaders(t *testing.T) {
	wire := "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: 2\r\n\r\n{}"
	got, err := ReadFrame(bufio.NewReader(strings.NewReader(wire)))
	if err != nil {
		t.Fatalf("读帧失败: %v", err)
	}
	if string(got) != "{}" {
		t.Errorf("消息体不一致: %q", got)
	}
}

func TestReadFrameHeaderNameCaseInsensitive(t *testing.T) {
	wire := "content-length: 2\r\n\r\n{}"
	if _, err := ReadFrame(bufio.NewReader(strings.NewReader(wire))); err != nil {
		t.Fatalf("小写头应被接受: %v", err)
	}
}

func TestReadFrameRejectsMissingLength(t *testing.T) {
	wire := "Content-Type: application/json\r\n\r\n{}"
	_, err := ReadFrame(bufio.NewReader(strings.NewReader(wire)))
	if err == nil {
		t.Fatal("缺少 Content-Length 应报错")
	}
	if !strings.Contains(err.Error(), "Content-Length") {
		t.Errorf("错误信息应提到 Content-Length，实际 %v", err)
	}
}

func TestReadFrameRejectsBadLength(t *testing.T) {
	for _, value := range []string{"abc", "-1"} {
		wire := "Content-Length: " + value + "\r\n\r\n{}"
		if _, err := ReadFrame(bufio.NewReader(strings.NewReader(wire))); err == nil {
			t.Errorf("Content-Length=%q 应报错", value)
		}
	}
}

func TestReadFrameRejectsOversizedLength(t *testing.T) {
	wire := "Content-Length: 100000000\r\n\r\n{}"
	_, err := ReadFrame(bufio.NewReader(strings.NewReader(wire)))
	if err == nil {
		t.Fatal("超大帧应报错")
	}
	if !strings.Contains(err.Error(), "过大") {
		t.Errorf("错误信息应说明帧过大，实际 %v", err)
	}
}

func TestReadFrameRejectsTruncatedBody(t *testing.T) {
	// 头声明 10 字节，实际只给 2 字节：必须报错，不能把半个消息交给上层。
	wire := "Content-Length: 10\r\n\r\n{}"
	_, err := ReadFrame(bufio.NewReader(strings.NewReader(wire)))
	if err == nil {
		t.Fatal("消息体截断应报错")
	}
}

func TestReadFrameRejectsMalformedHeader(t *testing.T) {
	wire := "NotAHeader\r\n\r\n{}"
	if _, err := ReadFrame(bufio.NewReader(strings.NewReader(wire))); err == nil {
		t.Fatal("不带冒号的头应报错")
	}
}
