// Package services 提供可绑定到前端的本地能力服务。
//
// 边界：Go 侧是**本地能力提供者**，不是第二个业务层。
// 任何"这个用户能不能合并""这条评论能不能删"的判断都必须回服务端；
// Go 里的代码只允许回答"本机是什么状态"。
package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// instanceProbeTimeout 是探活超时。
//
// 自托管实例常在内网/VPN 后面，探活失败是常态而不是异常：这里的超时短到
// 足以让 UI 立刻给出"连不上"的反馈，而不是让用户对着转圈等十秒。
const instanceProbeTimeout = 5 * time.Second

// InstanceInfo 是探活结果。字段刻意扁平：绑定方法的结构体会原样变成 TS 定义，
// 一旦嵌套内部字段就会被前端依赖住。
type InstanceInfo struct {
	// Reachable 表示实例可达。
	Reachable bool `json:"reachable"`
	// Title 是实例标题（来自 GET /）。
	Title string `json:"title"`
	// Version 是服务端应用版本。
	Version string `json:"version"`
	// APICompat 是服务端公布的兼容性声明；老实例没有该端点时为空。
	APICompat *APICompat `json:"apiCompat,omitempty"`
	// Error 是失败原因（可达时为空）。
	Error string `json:"error,omitempty"`
}

// APICompat 是 GET /api/v1/client-compat 的声明式响应。
//
// 与 Web 不同，桌面端启动时**还没登录**就要判断兼容性，所以这个端点必须
// 免鉴权——它也只公布契约版本与能力开关，不含实例敏感信息。
type APICompat struct {
	APIVersion    string          `json:"apiVersion"`
	APIMin        string          `json:"apiMin"`
	ServerVersion string          `json:"serverVersion"`
	Features      map[string]bool `json:"features"`
}

// Probe 探测实例可达性与版本。
//
// **直连上游、不走 bridge**：bridge 的 `/` 是桌面端自己的 SPA，两者不能共用
// 同一个路径。这也是为什么版本兼容判断放在 Go 而不是前端。
//
// Args:
//
//	baseURL: 实例根地址，如 https://kustos.example.com
//
// Returns:
//
//	实例信息；不可达时 Reachable=false 且 Error 说明原因（不返回 error，
//	让前端能直接展示"连不上"而不是走异常分支）。
func (s *SessionService) Probe(baseURL string) InstanceInfo {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return InstanceInfo{Error: "实例地址为空"}
	}

	root, err := s.getJSON(base + "/")
	if err != nil {
		return InstanceInfo{Error: err.Error()}
	}

	info := InstanceInfo{Reachable: true}
	if v, ok := root["title"].(string); ok {
		info.Title = v
	}
	if v, ok := root["version"].(string); ok {
		info.Version = v
	}

	// 兼容性声明是新增端点，老实例会 404：这里静默忽略，
	// 由前端回退到"只凭 version 判断"的旧路径。
	if compat, err := s.getJSON(base + "/api/v1/client-compat"); err == nil {
		info.APICompat = &APICompat{
			APIVersion:    stringField(compat, "api_version"),
			APIMin:        stringField(compat, "api_min"),
			ServerVersion: stringField(compat, "server_version"),
			Features:      boolMapField(compat, "features"),
		}
	}

	return info
}

// getJSON 发起 GET 并解析 JSON 对象。
func (s *SessionService) getJSON(url string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("构造请求失败: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接实例: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("实例返回 HTTP %d", resp.StatusCode)
	}

	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("响应不是有效 JSON: %w", err)
	}
	return payload, nil
}

func stringField(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func boolMapField(m map[string]any, key string) map[string]bool {
	raw, ok := m[key].(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]bool, len(raw))
	for k, v := range raw {
		if b, ok := v.(bool); ok {
			out[k] = b
		}
	}
	return out
}
