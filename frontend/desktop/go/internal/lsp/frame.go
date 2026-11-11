// Package lsp 管理本地语言服务器进程，并在 WebSocket 与 stdio 之间搬运协议帧。
//
// 分工：**进程归 Go，协议归前端**。Go 只做三件事——按需拉起服务器、限制同时
// 存活的数量、进程退出后按退避重拉——外加把 WebSocket 消息译成 stdio 帧（以及
// 反向）。它不解析 initialize、不持有文档版本号：LSP 的会话状态属于客户端，
// 代理一旦插进协议中间，两边的能力集与文档快照就会互相拉扯，而这类失步只在
// 用户开始敲字时才暴露，界面上看起来像是"补全偶尔不灵"。
//
// 为什么不用 bufio.Scanner 读服务器输出：LSP 是带 Content-Length 头的**帧**
// 协议，消息体里可以有换行。按行切会在第一条多行消息处错位，表现为"服务端
// 偶尔不回话"，日志里却看不到任何错误。
package lsp

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const (
	// maxFrameBytes 是单帧上限。语言服务器不会发这么大的消息；设上限是为了
	// 被坏数据喂进一个荒谬的 Content-Length 时立刻报错，而不是先分配 2GB
	// 再把进程 OOM 掉。
	maxFrameBytes = 64 << 20

	// maxHeaderLine 是单行头上限，理由同上。
	maxHeaderLine = 1 << 12
)

// ReadFrame 从 r 读出一条完整的 LSP 帧，返回消息体。
//
// r 必须是自己持久的 bufio.Reader：每次调用都新建一个会把多读进缓冲的字节
// 丢掉，而帧边界之外通常正好是下一帧的开头。
//
// Args:
//
//	r: 已缓冲的输入源
//
// Returns:
//
//	消息体；读到流末尾、头不合法或消息体截断时返回错误。
func ReadFrame(r *bufio.Reader) ([]byte, error) {
	length := -1
	for {
		line, err := readHeaderLine(r)
		if err != nil {
			return nil, err
		}
		if line == "" {
			break
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			return nil, fmt.Errorf("LSP 头格式无效: %q", line)
		}
		// Content-Type 之类的头对搬运没有意义，忽略即可；只认长度。
		if !strings.EqualFold(strings.TrimSpace(name), "content-length") {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || n < 0 {
			return nil, fmt.Errorf("LSP Content-Length 无效: %q", value)
		}
		length = n
	}
	if length < 0 {
		return nil, errors.New("LSP 帧缺少 Content-Length")
	}
	if length > maxFrameBytes {
		return nil, fmt.Errorf("LSP 帧过大: %d 字节", length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, fmt.Errorf("读取 LSP 消息体失败: %w", err)
	}
	return body, nil
}

// WriteFrame 写出一条 LSP 帧。
//
// Args:
//
//	w: 目标输出（通常是服务器进程的 stdin）
//	body: 消息体（已序列化的 JSON）
//
// Returns:
//
//	写入失败时返回错误；body 为空属调用方 bug，直接报错而不是发出一个
//	服务端无法解析的空帧。
func WriteFrame(w io.Writer, body []byte) error {
	if len(body) == 0 {
		return errors.New("LSP 帧内容为空")
	}
	if len(body) > maxFrameBytes {
		return fmt.Errorf("LSP 帧过大: %d 字节", len(body))
	}
	if _, err := io.WriteString(w, fmt.Sprintf("Content-Length: %d\r\n\r\n", len(body))); err != nil {
		return fmt.Errorf("写入 LSP 头失败: %w", err)
	}
	if _, err := w.Write(body); err != nil {
		return fmt.Errorf("写入 LSP 消息体失败: %w", err)
	}
	return nil
}

// readHeaderLine 读一行头，返回去掉行尾 \r\n 的内容。
//
// 空行（即头与消息体之间的分隔）返回空串且不报错。
func readHeaderLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		if errors.Is(err, io.EOF) && line == "" {
			return "", io.EOF
		}
		// 读到一半就到了流末尾：头被截断，照实报错而不是当成正常结束。
		return "", fmt.Errorf("读取 LSP 头失败: %w", err)
	}
	if len(line) > maxHeaderLine {
		return "", errors.New("LSP 头过长")
	}
	return strings.TrimRight(line, "\r\n"), nil
}
