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
// 判据顺序上兼容性声明优先于根路径：真实部署里 `GET /` 返回的是前端 SPA 的
// HTML（网关把根路径让给了前端路由），在那里解析 JSON 会把所有真实实例判成
// "连不上"。兼容性声明本来就是免鉴权的公开面，正是为"还没登录就要判断
// 这家实例能不能用"准备的。
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

	info := InstanceInfo{}

	// 兼容性声明是判定可达与版本的主依据。老实例没有这个端点（404），
	// 那时才回退到根路径的 JSON。
	if compat, err := s.getJSON(base + "/api/v1/client-compat"); err == nil {
		info.Reachable = true
		info.APICompat = &APICompat{
			APIVersion:    stringField(compat, "api_version"),
			APIMin:        stringField(compat, "api_min"),
			ServerVersion: stringField(compat, "server_version"),
			Features:      boolMapField(compat, "features"),
		}
		info.Version = info.APICompat.ServerVersion
	}

	// 根路径只在还没判定可达时兜底（老实例），并且**必须确认拿到的是 JSON**：
	// 返回 HTML 说明这是前端页面，不是 API 响应。
	if !info.Reachable {
		root, err := s.getJSONStrict(base + "/")
		if err != nil {
			return InstanceInfo{Error: err.Error()}
		}
		info.Reachable = true
		if v, ok := root["title"].(string); ok {
			info.Title = v
		}
		if v, ok := root["version"].(string); ok && info.Version == "" {
			info.Version = v
		}
	}

	return info
}

// getJSON 发起 GET 并解析 JSON 对象。
func (s *SessionService) getJSON(url string) (map[string]any, error) {
	return s.doGetJSON(url, false)
}

// getJSONStrict 与 getJSON 相同，但要求响应**确实是** JSON。
//
// 用于"根路径兜底"：真实部署的 `GET /` 返回 HTML，那个页面不是 API 响应，
// 也不能被当成"实例可达"的证据。只按状态码判断会把前端页面认成 API。
func (s *SessionService) getJSONStrict(url string) (map[string]any, error) {
	return s.doGetJSON(url, true)
}

func (s *SessionService) doGetJSON(url string, requireJSON bool) (map[string]any, error) {
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

	if requireJSON {
		// 明确按 HTML 拒绝：有些部署会把未命中的路径兜底成前端页面，
		// 状态码是 200，但那是页面而不是接口，不能被当成"实例可达"的证据。
		//
		// 判定用"像 HTML"而不是"必须是 JSON"：老实例的 Content-Type 未必规范，
		// 只要能解析成 JSON 对象就应当认，收紧到 Content-Type 会把可用实例误杀。
		ct := strings.ToLower(resp.Header.Get("Content-Type"))
		if strings.Contains(ct, "html") {
			return nil, fmt.Errorf("期望 JSON 响应，实际是 %q", ct)
		}
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
