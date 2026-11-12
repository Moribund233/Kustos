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
	"os"
	"time"

	sqlite "modernc.org/sqlite"
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
	// v3：本地工作副本。
	//
	// path 唯一而不是 (instance_id, path)：一个工作树只可能属于一次克隆，
	// 同一目录被两台实例反复"添加"只会让用户困惑。repo_id 允许为空——
	// 本地 clone 未必对得上服务端仓库（例如先 clone 后建仓库）。
	//
	// ahead/behind/dirty 是**上一次扫描的快照**，不是实时状态：列表要能立刻
	// 出内容，逐仓库跑 git status 在大工作树上要几秒。真正的实时状态由
	// WorkingCopyService.Status 现算。
	{
		`CREATE TABLE IF NOT EXISTS working_copies (
			id           TEXT PRIMARY KEY,
			instance_id  TEXT NOT NULL DEFAULT '',
			repo_id      INTEGER NOT NULL DEFAULT 0,
			path         TEXT NOT NULL,
			branch       TEXT NOT NULL DEFAULT '',
			ahead        INTEGER NOT NULL DEFAULT 0,
			behind       INTEGER NOT NULL DEFAULT 0,
			dirty        INTEGER NOT NULL DEFAULT 0,
			last_scan_at INTEGER NOT NULL DEFAULT 0,
			created_at   INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_working_copies_path ON working_copies(path)`,
	},
	// v4：未保存的编辑器 buffer。
	//
	// 只存**改了但没存**的内容。崩溃或强杀后重开，能恢复用户的工作；
	// 保存成功后这一行立即删除，因此表的大小由"当前打开了几个未保存文件"
	// 决定，不随时间增长。
	//
	// base_mtime 是开始编辑时磁盘文件的修改时间：恢复后保存前用它比对，
	// 磁盘在崩溃期间被别的东西改过时要让用户先看清再决定覆盖。
	{
		`CREATE TABLE IF NOT EXISTS buffer_recovery (
			working_copy_id TEXT NOT NULL,
			path            TEXT NOT NULL,
			content         TEXT NOT NULL,
			base_mtime      INTEGER NOT NULL DEFAULT 0,
			saved_at        INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (working_copy_id, path)
		)`,
	},
	// v5：工作区信任。
	//
	// 语言服务器会执行工作区里的代码（pyright 解析 import、tsserver 加载
	// package.json 里的脚本、gopls 跑 go list），所以"要不要在工作区里启动
	// 本地语言服务器"必须是用户点过头的决定，不能默认开。
	//
	// 键是工作区根的绝对路径，而不是工作副本 id：信任的对象是磁盘上那个目录，
	// 换一个工作副本指向同一目录时不该再问一遍；反过来，同一 id 换了目录
	// （用户搬了目录再添加）就必须重新确认。
	{
		`CREATE TABLE IF NOT EXISTS workspace_trust (
			path       TEXT PRIMARY KEY,
			trusted    INTEGER NOT NULL DEFAULT 0,
			decided_at INTEGER NOT NULL DEFAULT 0
		)`,
	},
	// v6：信任记录绑定远端 origin。
	//
	// 信任的对象不是"这个磁盘目录"，而是"这个目录里来自某个远端的代码"：
	// 语言服务器执行的是目录里的代码，而把 remote url 改指另一个仓库之后，
	// 同一个目录里的代码就换来源了。这时旧的点头不该顺延，得再问一次。
	//
	// 旧记录（本版之前做出的决定）origin 为空，表示"当时没有记录来源"，
	// 与空 origin 比较视为未变化——升级不能把所有既有信任一次性作废。
	{
		`ALTER TABLE workspace_trust ADD COLUMN origin TEXT NOT NULL DEFAULT ''`,
	},
}

// Open 打开（必要时创建）本地库。
//
// 文件被别的进程短暂占用（杀软扫描、上个进程没退干净）会重试；库文件本身
// 损坏则改名隔离后重建——本地库存的是可重建的本机事实，一次坏文件不该让
// 桌面端永久起不来。
//
// Args:
//
//	path: 数据库文件路径；传 ":memory:" 可用于测试。
//
// Returns:
//
//	可用的数据库句柄；文件被占用且重试无效、或隔离失败时返回错误。
func Open(path string) (*DB, error) {
	dsn := path
	if path != ":memory:" {
		// WAL 提升并发读性能（多窗口同时读实例列表是常态）；
		// busy_timeout 避免短暂写锁直接报错。
		dsn = fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", path)
	}

	db, err := openWithRetry(dsn)
	if err == nil {
		return db, nil
	}
	if path == ":memory:" || !isCorrupt(err) {
		if sqliteCode(err) == sqliteCantOpen {
			return nil, fmt.Errorf("%w（本地库被其他进程占用或目录不可写，稍后重试）", err)
		}
		return nil, err
	}
	if qerr := quarantine(path); qerr != nil {
		return nil, qerr
	}
	return openWithRetry(dsn)
}

// openAttempts 是同一进程内的打开尝试次数。
//
// 只兜住"秒级"的占用（扫描、句柄晚释放）：DSN 里的 busy_timeout 已经等过
// 一次锁，再多次重试只是让用户对着空屏幕多等。
const openAttempts = 2

// openRetryDelay 是两次尝试之间的间隔；测试会调小。
var openRetryDelay = 400 * time.Millisecond

func openWithRetry(dsn string) (*DB, error) {
	var lastErr error
	for attempt := 0; attempt < openAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(openRetryDelay)
		}
		db, err := openOnce(dsn)
		if err == nil {
			return db, nil
		}
		lastErr = err
		if !isRetryable(err) {
			break
		}
	}
	return nil, lastErr
}

func openOnce(dsn string) (*DB, error) {
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

// SQLite 结果码：只区分"打不开"和"文件坏了"，其余原样上报。
const (
	sqliteBusy     = 5
	sqliteLocked   = 6
	sqliteCorrupt  = 11
	sqliteCantOpen = 14
	sqliteNotADB   = 26
)

func sqliteCode(err error) int {
	var se *sqlite.Error
	if errors.As(err, &se) {
		return se.Code()
	}
	return 0
}

// isRetryable 判断错误是否可能自己消失（锁竞争、文件被短暂占用）。
func isRetryable(err error) bool {
	switch sqliteCode(err) {
	case sqliteBusy, sqliteLocked, sqliteCantOpen:
		return true
	}
	return false
}

// isCorrupt 判断库文件本身是否已损坏：坏文件重试多少次结果都一样。
func isCorrupt(err error) bool {
	c := sqliteCode(err)
	return c == sqliteCorrupt || c == sqliteNotADB
}

// quarantine 把坏库连同 WAL 侧文件改名留存，便于事后排查。
func quarantine(path string) error {
	suffix := ".corrupt-" + time.Now().Format("20060102-150405")
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		if _, err := os.Stat(p); err != nil {
			continue
		}
		if err := os.Rename(p, p+suffix); err != nil {
			return fmt.Errorf("隔离损坏的本地库失败（%s）: %w", p, err)
		}
	}
	return nil
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

// WorkingCopy 是一条本地工作副本记录。
//
// 它是"本机事实"：路径、当前分支、相对远端的领先/落后、是否有未提交改动。
// **不缓存权限或仓库可见性**——那些回服务端裁决。
//
// Ahead/Behind/Dirty 是上一次扫描的快照；实时状态现算（见 Status）。
type WorkingCopy struct {
	ID         string `json:"id"`
	InstanceID string `json:"instanceId"`
	RepoID     int64  `json:"repoId"`
	Path       string `json:"path"`
	Branch     string `json:"branch"`
	Ahead      int    `json:"ahead"`
	Behind     int    `json:"behind"`
	Dirty      bool   `json:"dirty"`
	LastScanAt int64  `json:"lastScanAt"`
	CreatedAt  int64  `json:"createdAt"`
}

// ErrWorkingCopyNotFound 表示按 id 没有找到工作副本。
var ErrWorkingCopyNotFound = errors.New("工作副本不存在")

// ListWorkingCopies 返回所有工作副本，按添加时间升序。
func (d *DB) ListWorkingCopies() ([]WorkingCopy, error) {
	rows, err := d.sql.Query(`
		SELECT id, instance_id, repo_id, path, branch, ahead, behind, dirty, last_scan_at, created_at
		FROM working_copies ORDER BY created_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("查询工作副本失败: %w", err)
	}
	defer func() { _ = rows.Close() }()

	// 空切片而非 nil：绑定到前端时 nil 会变成 null。
	list := make([]WorkingCopy, 0)
	for rows.Next() {
		var wc WorkingCopy
		if err := rows.Scan(
			&wc.ID, &wc.InstanceID, &wc.RepoID, &wc.Path, &wc.Branch,
			&wc.Ahead, &wc.Behind, &wc.Dirty, &wc.LastScanAt, &wc.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("读取工作副本行失败: %w", err)
		}
		list = append(list, wc)
	}
	return list, rows.Err()
}

// SaveWorkingCopy 新增或更新工作副本（按 path upsert）。
//
// Args:
//
//	wc: 待保存的记录；ID 与 Path 必填
//
// Returns:
//
//	缺字段或写入失败时返回错误。
func (d *DB) SaveWorkingCopy(wc WorkingCopy) error {
	if wc.ID == "" {
		return errors.New("工作副本 ID 不能为空")
	}
	if wc.Path == "" {
		return errors.New("工作副本路径不能为空")
	}
	now := time.Now().Unix()
	if wc.CreatedAt == 0 {
		wc.CreatedAt = now
	}
	_, err := d.sql.Exec(`
		INSERT INTO working_copies
			(id, instance_id, repo_id, path, branch, ahead, behind, dirty, last_scan_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			instance_id = excluded.instance_id,
			repo_id     = excluded.repo_id,
			branch      = excluded.branch,
			ahead       = excluded.ahead,
			behind      = excluded.behind,
			dirty       = excluded.dirty,
			last_scan_at = excluded.last_scan_at`,
		wc.ID, wc.InstanceID, wc.RepoID, wc.Path, wc.Branch,
		wc.Ahead, wc.Behind, wc.Dirty, wc.LastScanAt, wc.CreatedAt)
	if err != nil {
		return fmt.Errorf("保存工作副本失败: %w", err)
	}
	return nil
}

// GetWorkingCopy 按 id 取工作副本；不存在返回 false。
func (d *DB) GetWorkingCopy(id string) (WorkingCopy, bool, error) {
	var wc WorkingCopy
	err := d.sql.QueryRow(`
		SELECT id, instance_id, repo_id, path, branch, ahead, behind, dirty, last_scan_at, created_at
		FROM working_copies WHERE id = ?`, id).
		Scan(&wc.ID, &wc.InstanceID, &wc.RepoID, &wc.Path, &wc.Branch,
			&wc.Ahead, &wc.Behind, &wc.Dirty, &wc.LastScanAt, &wc.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkingCopy{}, false, nil
	}
	if err != nil {
		return WorkingCopy{}, false, fmt.Errorf("查询工作副本失败: %w", err)
	}
	return wc, true, nil
}

// GetWorkingCopyByPath 按路径取工作副本。
//
// 添加同一目录两次时应命中同一行，因此需要按 path 回查（upsert 会保留原有 id）。
func (d *DB) GetWorkingCopyByPath(path string) (WorkingCopy, bool, error) {
	var wc WorkingCopy
	err := d.sql.QueryRow(`
		SELECT id, instance_id, repo_id, path, branch, ahead, behind, dirty, last_scan_at, created_at
		FROM working_copies WHERE path = ?`, path).
		Scan(&wc.ID, &wc.InstanceID, &wc.RepoID, &wc.Path, &wc.Branch,
			&wc.Ahead, &wc.Behind, &wc.Dirty, &wc.LastScanAt, &wc.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkingCopy{}, false, nil
	}
	if err != nil {
		return WorkingCopy{}, false, fmt.Errorf("查询工作副本失败: %w", err)
	}
	return wc, true, nil
}

// DeleteWorkingCopy 删除工作副本记录。
//
// 只删记录，**不碰磁盘上的工作树**：用户不期望"从列表移除"等于删掉目录。
func (d *DB) DeleteWorkingCopy(id string) error {
	_, err := d.sql.Exec(`DELETE FROM working_copies WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("删除工作副本失败: %w", err)
	}
	return nil
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

// BufferRecovery 是一条未保存的编辑器 buffer。
type BufferRecovery struct {
	// WorkingCopyID 与 Path 一起确定唯一一个文件。
	WorkingCopyID string `json:"workingCopyId"`
	// Path 是相对仓库根的路径。
	Path string `json:"path"`
	// Content 是用户改动后的全文。
	Content string `json:"content"`
	// BaseMtime 是开始编辑时磁盘文件的修改时间（Unix 纳秒）。
	BaseMtime int64 `json:"baseMtime"`
	// SavedAt 是最后一次记录的 Unix 秒时间戳。
	SavedAt int64 `json:"savedAt"`
}

// SaveBufferRecovery 记录一份未保存的 buffer（按 工作副本 + 路径 upsert）。
//
// Args:
//
//	b: 待保存的记录；WorkingCopyID 与 Path 必填
//
// Returns:
//
//	缺字段或写入失败时返回错误。
//
// 这个表**只该装未保存的内容**：保存成功后必须调用 ClearBufferRecovery，
// 否则下次启动会把已经写进磁盘的旧内容当成"待恢复的改动"再提一次。
func (d *DB) SaveBufferRecovery(b BufferRecovery) error {
	if b.WorkingCopyID == "" {
		return errors.New("工作副本 ID 不能为空")
	}
	if b.Path == "" {
		return errors.New("buffer 路径不能为空")
	}
	if b.SavedAt == 0 {
		b.SavedAt = time.Now().Unix()
	}
	_, err := d.sql.Exec(`
		INSERT INTO buffer_recovery (working_copy_id, path, content, base_mtime, saved_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(working_copy_id, path) DO UPDATE SET
			content    = excluded.content,
			base_mtime = excluded.base_mtime,
			saved_at   = excluded.saved_at`,
		b.WorkingCopyID, b.Path, b.Content, b.BaseMtime, b.SavedAt)
	if err != nil {
		return fmt.Errorf("保存 buffer 失败: %w", err)
	}
	return nil
}

// ListBufferRecoveries 返回某个工作副本下所有未保存的 buffer。
//
// Returns:
//
//	按路径排序的列表；没有记录时返回空切片。
func (d *DB) ListBufferRecoveries(workingCopyID string) ([]BufferRecovery, error) {
	rows, err := d.sql.Query(`
		SELECT working_copy_id, path, content, base_mtime, saved_at
		FROM buffer_recovery WHERE working_copy_id = ? ORDER BY path ASC`, workingCopyID)
	if err != nil {
		return nil, fmt.Errorf("查询 buffer 失败: %w", err)
	}
	defer func() { _ = rows.Close() }()

	// 空切片而非 nil：绑定到前端时 nil 会变成 null。
	list := make([]BufferRecovery, 0)
	for rows.Next() {
		var b BufferRecovery
		if err := rows.Scan(&b.WorkingCopyID, &b.Path, &b.Content, &b.BaseMtime, &b.SavedAt); err != nil {
			return nil, fmt.Errorf("读取 buffer 行失败: %w", err)
		}
		list = append(list, b)
	}
	return list, rows.Err()
}

// ClearBufferRecovery 删除一份 buffer 记录。
//
// 保存成功、用户选择放弃改动、或文件已从工作树移除时都调用它。
func (d *DB) ClearBufferRecovery(workingCopyID, path string) error {
	_, err := d.sql.Exec(`
		DELETE FROM buffer_recovery WHERE working_copy_id = ? AND path = ?`,
		workingCopyID, path)
	if err != nil {
		return fmt.Errorf("删除 buffer 失败: %w", err)
	}
	return nil
}

// ClearBufferRecoveriesFor 删除某个工作副本的全部 buffer 记录。
//
// 工作副本被移除时用：留下的记录会永远等不到对应的仓库。
func (d *DB) ClearBufferRecoveriesFor(workingCopyID string) error {
	_, err := d.sql.Exec(`DELETE FROM buffer_recovery WHERE working_copy_id = ?`, workingCopyID)
	if err != nil {
		return fmt.Errorf("删除 buffer 失败: %w", err)
	}
	return nil
}

// WorkspaceTrust 是一个工作区目录的信任决定。
type WorkspaceTrust struct {
	// Path 是工作区根的绝对路径。
	Path string `json:"path"`
	// Trusted 表示用户是否允许在该目录里运行本地语言服务器。
	Trusted bool `json:"trusted"`
	// Origin 是做出决定时该目录的远端地址；空表示当时没有远端，
	// 或是本版之前记下的决定（那时还不记来源）。
	Origin string `json:"origin"`
	// DecidedAt 是做出决定的 Unix 秒时间戳；0 表示还没问过。
	DecidedAt int64 `json:"decidedAt"`
}

// AppliesTo 判断一条信任决定是否仍适用于给定的远端地址。
//
// 信任的对象是"这个目录里来自某个远端的代码"而不是"这个磁盘目录"：把
// remote url 改指到另一个仓库之后，同一个目录里的代码就换来源了，旧的点头
// 不该顺延。
//
// 任何一侧为空都按"来源未变"放行：空出现在两种正常场合——本版之前做出的
// 决定，以及本地仓库还没配远端。两种都不该让用户重答一次。
func (t WorkspaceTrust) AppliesTo(origin string) bool {
	if t.Origin == "" || origin == "" {
		return true
	}
	return t.Origin == origin
}

// SetWorkspaceTrust 记录用户对一个工作区目录的信任决定。
//
// Args:
//
//	path:    工作区根的绝对路径
//	origin:  做出决定时的远端地址；没有远端时传空串
//	trusted: 是否允许运行本地语言服务器
//
// Returns:
//
//	路径为空或写入失败时返回错误。
func (d *DB) SetWorkspaceTrust(path, origin string, trusted bool) error {
	if path == "" {
		return errors.New("工作区路径不能为空")
	}
	flag := 0
	if trusted {
		flag = 1
	}
	_, err := d.sql.Exec(`
		INSERT INTO workspace_trust (path, trusted, origin, decided_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			trusted    = excluded.trusted,
			origin     = excluded.origin,
			decided_at = excluded.decided_at`,
		path, flag, origin, time.Now().Unix())
	if err != nil {
		return fmt.Errorf("保存工作区信任失败: %w", err)
	}
	return nil
}

// GetWorkspaceTrust 读取一个工作区目录的信任记录。
//
// Returns:
//
//	记录、是否存在、错误。没有记录时返回零值与 false——"还没问过"和
//	"问过但拒绝了"是两种状态，调用方要据此决定是弹确认还是直接降级。
func (d *DB) GetWorkspaceTrust(path string) (WorkspaceTrust, bool, error) {
	var (
		flag      int
		origin    string
		decidedAt int64
	)
	err := d.sql.QueryRow(
		`SELECT trusted, origin, decided_at FROM workspace_trust WHERE path = ?`, path,
	).Scan(&flag, &origin, &decidedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceTrust{}, false, nil
	}
	if err != nil {
		return WorkspaceTrust{}, false, fmt.Errorf("读取工作区信任失败: %w", err)
	}
	return WorkspaceTrust{Path: path, Trusted: flag != 0, Origin: origin, DecidedAt: decidedAt}, true, nil
}

// ClearWorkspaceTrust 忘掉一个工作区目录的信任决定。
//
// 工作副本被移除时用；也用于"重新确认"。
func (d *DB) ClearWorkspaceTrust(path string) error {
	_, err := d.sql.Exec(`DELETE FROM workspace_trust WHERE path = ?`, path)
	if err != nil {
		return fmt.Errorf("删除工作区信任失败: %w", err)
	}
	return nil
}
