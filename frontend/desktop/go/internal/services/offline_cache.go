package services

import (
	"fmt"
	"strings"
	"time"

	"github.com/kustos/kustos-desktop/internal/store"
)

// offlineCacheMaxAge 是缓存的保留窗口。
//
// 七天：超过这个时间的响应已经不能用来回答"现在是什么状态"了，
// 而离线翻旧数据本来就是为了撑过一次断网，不是为了当历史库。
const offlineCacheMaxAge = 7 * 24 * time.Hour

// OfflineCacheService 给界面提供只读数据的离线缓存。
//
// 边界：它只做"存一份 JSON、按 key 取回来"，**不解释内容**——缓存的是 Inbox
// 列表还是某个 PR 的详情，取决于前端给的 key；这一层既不解析也不校验业务字段。
//
// 只缓存**只读**数据。能写的东西（草稿、提交）有自己的表，不能靠"恢复一份
// 旧 JSON"来冒充写成功；把两者混在一起，一次误用就会变成静默的数据丢失。
type OfflineCacheService struct {
	store *store.DB
}

// NewOfflineCacheService 构造离线缓存服务。
//
// Args:
//
//	db: 本地库；为 nil 时所有方法返回明确错误（而不是静默成功）
func NewOfflineCacheService(db *store.DB) *OfflineCacheService {
	return &OfflineCacheService{store: db}
}

// OfflineCacheEntry 是一份缓存记录。
type OfflineCacheEntry struct {
	// Payload 是原样保存的 JSON 文本。
	Payload string `json:"payload"`
	// FetchedAt 是取回时刻的 Unix 毫秒。
	//
	// 用毫秒而不是纳秒：纳秒超出 JS 安全整数范围，经绑定层会被舍入。
	FetchedAt int64 `json:"fetchedAt"`
}

// errCacheUnavailable 表示本地库未接线。
var errCacheUnavailable = fmt.Errorf("离线缓存不可用：本地库未打开")

// Put 写入一份缓存。
//
// Args:
//
//	key:     查询标识
//	payload: 要缓存的 JSON 文本
//
// Returns:
//
//	key 为空、内容过大或写库失败时返回错误。
//
// 内容有上限：一次 PR 详情的 diff 可能很大，而缓存不该成为第二个数据仓库。
func (s *OfflineCacheService) Put(key, payload string) error {
	if s.store == nil {
		return errCacheUnavailable
	}
	if strings.TrimSpace(key) == "" {
		return fmt.Errorf("缓存 key 不能为空")
	}
	if len(payload) > offlineCacheMaxPayload {
		return fmt.Errorf("缓存内容超过上限（%d 字节）", offlineCacheMaxPayload)
	}
	return s.store.SetOfflineCache(key, payload)
}

// Get 读取一份缓存。
//
// Args:
//
//	key: 查询标识
//
// Returns:
//
//	缓存内容；未命中或已过期时 `found` 为 false。
func (s *OfflineCacheService) Get(key string) (OfflineCacheEntry, bool, error) {
	if s.store == nil {
		return OfflineCacheEntry{}, false, errCacheUnavailable
	}
	cached, ok, err := s.store.GetOfflineCache(key, offlineCacheMaxAge)
	if err != nil || !ok {
		return OfflineCacheEntry{}, false, err
	}
	return OfflineCacheEntry{
		Payload:   cached.Payload,
		FetchedAt: cached.FetchedAt * 1000,
	}, true, nil
}

// Prune 清理过期缓存。
//
// Returns:
//
//	删除的条数。
//
// 启动路径调一次：缓存攒着几个月前的响应既占空间，也让"离线时看到的是
// 什么时候的数据"更难回答。
func (s *OfflineCacheService) Prune() int {
	if s.store == nil {
		return 0
	}
	removed, err := s.store.PruneOfflineCache(offlineCacheMaxAge)
	if err != nil {
		return 0
	}
	return int(removed)
}

// offlineCacheMaxPayload 是单条缓存的内容上限（8 MiB）。
//
// 够放一份大 PR 的 diff，又不至于让本地库被一次误写撑爆。
const offlineCacheMaxPayload = 8 << 20
