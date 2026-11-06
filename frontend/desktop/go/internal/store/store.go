// Package store 是桌面端的本地事实存储。
//
// 一条规则：**前端缓存 = 服务端镜像；SQLite = 本机事实**。两者不混：
//   - IndexedDB 存 HTTP 响应缓存（TanStack Query 的 persistQueryClient）
//   - SQLite 存实例档案、工作副本、草稿、UI 状态、本地索引
//
// 为什么 SQLite 而不是 JSON 文件：需要事务、需要迁移、需要按列查询。
// 用 JSON 会在"多窗口同时写实例档案"时丢更新，而 SQLite 的事务免费解决它。
//
// 驱动用 modernc.org/sqlite（纯 Go）：CGO 会毁掉跨平台交叉编译，
// Wails 的三平台产出不能依赖本地 C 工具链。
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// DB 是本地存储句柄。
type DB struct {
	sql *sql.DB
}

// Instance 是一台已添加的 Kustos 实例。
//
// `tls_pin` 留给自签证书场景，但**不提供"忽略所有证书错误"的开关**：
// 那等于把中间人攻击的入口交给用户。
type Instance struct {
	ID        string `json:"id"`
	BaseURL   string `json:"baseUrl"`
	Name      string `json:"name"`
	Version   string `json:"version"`
	TLSPin    string `json:"tlsPin,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

// migrationSteps 是每个版本包含的语句列表。
//
// 拆成 [][]string 而不是单个多语句字符串：modernc.org/sqlite 在事务内
// 执行含多条语句的 SQL 时可能返回 "unable to open database file"，
// 逐条执行既避开这个坑，也让失败时能准确指出是第几条语句挂了。
var migrationSteps = [][]string{
	// v1：实例档案。后续在此追加 working_copies / drafts / ui_state 等表。
	{
		`CREATE TABLE IF NOT EXISTS instances (
			id         TEXT PRIMARY KEY,
			base_url   TEXT NOT NULL,
			name       TEXT NOT NULL DEFAULT '',
			version    TEXT NOT NULL DEFAULT '',
			tls_pin    TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_base_url ON instances(base_url)`,
	},
	// v2：UI 状态。
	//
	// 值存 JSON 文本而不是拆列：窗口边界、分栏宽度、上次停留的 surface
	// 这些形状会随界面演进而变，拆成列意味着每加一个偏好就要写一次迁移。
	// 按 key 存整块 JSON 让界面自己定义结构，存储层不必跟着改。
	{
		`CREATE TABLE IF NOT EXISTS ui_state (
			key        TEXT PRIMARY KEY,
			value      TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
	},
}

// Open 打开（必要时创建）本地库。
//
// Args:
//
//	path: 数据库文件路径；传 ":memory:" 可用于测试。
func Open(path string) (*DB, error) {
	dsn := path
	if path != ":memory:" {
		// WAL 提升并发读性能（多窗口同时读实例列表是常态）；
		// busy_timeout 避免短暂写锁直接报错。
		dsn = fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", path)
	}

	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开本地数据库失败: %w", err)
	}
	// SQLite 单写者：连接数压到 1 可避免"database is locked"的偶发失败。
	sqlDB.SetMaxOpenConns(1)

	db := &DB{sql: sqlDB}
	if err := db.migrate(); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}
	return db, nil
}

func (d *DB) migrate() error {
	if _, err := d.sql.Exec(`CREATE TABLE IF NOT EXISTS schema_version (
		version INTEGER NOT NULL
	)`); err != nil {
		return fmt.Errorf("创建版本表失败: %w", err)
	}

	var current int
	err := d.sql.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_version`).Scan(&current)
	if err != nil {
		return fmt.Errorf("读取 schema 版本失败: %w", err)
	}

	for v := current; v < len(migrationSteps); v++ {
		tx, err := d.sql.Begin()
		if err != nil {
			return fmt.Errorf("开启迁移事务失败: %w", err)
		}
		for i, stmt := range migrationSteps[v] {
			if _, err := tx.Exec(stmt); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("迁移到 v%d 的第 %d 条语句失败: %w", v+1, i+1, err)
			}
		}
		if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, v+1); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("记录版本 v%d 失败: %w", v+1, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("提交迁移 v%d 失败: %w", v+1, err)
		}
	}
	return nil
}

// Close 关闭数据库。
func (d *DB) Close() error { return d.sql.Close() }

// ListInstances 返回已保存的实例，按添加时间升序。
func (d *DB) ListInstances() ([]Instance, error) {
	rows, err := d.sql.Query(`
		SELECT id, base_url, name, version, tls_pin, created_at
		FROM instances ORDER BY created_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("查询实例失败: %w", err)
	}
	defer func() { _ = rows.Close() }()

	// 返回空切片而非 nil：绑定到前端时 nil 会变成 null，
	// 让前端多写一个判空分支。
	instances := make([]Instance, 0)
	for rows.Next() {
		var it Instance
		if err := rows.Scan(&it.ID, &it.BaseURL, &it.Name, &it.Version, &it.TLSPin, &it.CreatedAt); err != nil {
			return nil, fmt.Errorf("读取实例行失败: %w", err)
		}
		instances = append(instances, it)
	}
	return instances, rows.Err()
}

// SaveInstance 新增或更新实例（按 id upsert）。
//
// 同一 base_url 视为同一台实例：重复添加时更新而不是插入第二行，
// 否则用户会在切换器里看到两个一模一样的条目。
func (d *DB) SaveInstance(it Instance) error {
	if it.ID == "" {
		return errors.New("实例 ID 不能为空")
	}
	if it.CreatedAt == 0 {
		it.CreatedAt = time.Now().Unix()
	}
	_, err := d.sql.Exec(`
		INSERT INTO instances (id, base_url, name, version, tls_pin, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(base_url) DO UPDATE SET
			name = excluded.name,
			version = excluded.version,
			tls_pin = excluded.tls_pin`,
		it.ID, it.BaseURL, it.Name, it.Version, it.TLSPin, it.CreatedAt)
	if err != nil {
		return fmt.Errorf("保存实例失败: %w", err)
	}
	return nil
}

// DeleteInstance 删除实例档案。
//
// 只删实例档案与该实例的凭据，**不删**工作副本记录：
// 用户不期望"登出"把自己 clone 过的仓库记录一起清掉。
func (d *DB) DeleteInstance(id string) error {
	_, err := d.sql.Exec(`DELETE FROM instances WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("删除实例失败: %w", err)
	}
	return nil
}

// GetInstance 按 id 取实例；不存在返回空值与 false。
func (d *DB) GetInstance(id string) (Instance, bool, error) {
	var it Instance
	err := d.sql.QueryRow(`
		SELECT id, base_url, name, version, tls_pin, created_at
		FROM instances WHERE id = ?`, id).
		Scan(&it.ID, &it.BaseURL, &it.Name, &it.Version, &it.TLSPin, &it.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Instance{}, false, nil
	}
	if err != nil {
		return Instance{}, false, fmt.Errorf("查询实例失败: %w", err)
	}
	return it, true, nil
}

// GetInstanceByBaseURL 按地址取实例；不存在返回空值与 false。
//
// 存在的理由：SaveInstance 按 base_url 冲突时保留原有 id，所以"调用方传入的
// id"未必是"库里最终那一行的 id"。需要拿到真正生效的行时必须回查一次，
// 否则前端会拿着一个库里不存在的 id 去登录。
func (d *DB) GetInstanceByBaseURL(baseURL string) (Instance, bool, error) {
	var it Instance
	err := d.sql.QueryRow(`
		SELECT id, base_url, name, version, tls_pin, created_at
		FROM instances WHERE base_url = ?`, baseURL).
		Scan(&it.ID, &it.BaseURL, &it.Name, &it.Version, &it.TLSPin, &it.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Instance{}, false, nil
	}
	if err != nil {
		return Instance{}, false, fmt.Errorf("查询实例失败: %w", err)
	}
	return it, true, nil
}

// SetUIState 按 key 覆盖写入一段 UI 状态。
//
// Args:
//
//	key:   状态标识（如 "window.main"），调用方约定，存储层不解释
//	value: 任意 JSON 文本，原样保存
//
// Returns:
//
//	写入失败时返回错误。
func (d *DB) SetUIState(key, value string) error {
	if key == "" {
		return errors.New("UI 状态 key 不能为空")
	}
	_, err := d.sql.Exec(`
		INSERT INTO ui_state (key, value, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			value = excluded.value,
			updated_at = excluded.updated_at`,
		key, value, time.Now().Unix())
	if err != nil {
		return fmt.Errorf("保存 UI 状态失败: %w", err)
	}
	return nil
}

// GetUIState 读取一段 UI 状态。
//
// Returns:
//
//	值、是否命中、错误。未命中时返回空串与 false——首次启动就该走默认值，
//	而不是让调用方把"没有记录"当成错误处理。
func (d *DB) GetUIState(key string) (string, bool, error) {
	var value string
	err := d.sql.QueryRow(`SELECT value FROM ui_state WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("读取 UI 状态失败: %w", err)
	}
	return value, true, nil
}
