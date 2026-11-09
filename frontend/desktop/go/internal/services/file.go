package services

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/kustos/kustos-desktop/internal/store"
)

// 文本文件的读写与写盘冲突检测。
//
// 这里是编辑器能"改得动"的那一层：读回原文、把编辑后的内容写回磁盘，
// 并在写之前确认磁盘上的文件没有被别的东西改过。
//
// 边界与 Code 面一致：只回答"本机这个文件现在是什么"，路径必须收敛在
// 仓库根之内，校验统一走 resolveInside。

// FileText 是一次文本读取的结果。
type FileText struct {
	// Content 是文件原文。
	Content string `json:"content"`
	// Mtime 是文件的修改时间（Unix **毫秒**），写回时作为冲突检测的基准。
	//
	// 用毫秒而不是纳秒：绑定层把 Go 的 int64 转成 JSON 数字交给 JS，
	// 而 JS 的 Number 只有 53 位整数精度（约 9e15）。纳秒时间戳是 1.7e18，
	// 往返一次就会被舍入，写回时永远对不上——表现为"刚打开的文件也报冲突"。
	// 毫秒量级（1.7e12）在安全范围内，且文件系统的时间精度本就远粗于纳秒。
	Mtime int64 `json:"mtime"`
	// Size 是文件字节数。
	Size int64 `json:"size"`
}

// ErrFileChanged 表示磁盘上的文件在读取之后被改动过。
//
// 单独定义而不是拼错误字符串：前端要据此弹出"磁盘已被外部修改"的选择，
// 靠错误文案判断会在翻译或措辞调整时静默失效。
var ErrFileChanged = errors.New("文件已被外部修改")

// ReadText 读取文件内容并附上修改时间。
//
// 与 ReadFile 的区别是它同时返回 mtime：写回时要用这个值判断"我读到的
// 是不是还是磁盘上那一份"。只读浏览走 ReadFile 就够了。
//
// Args:
//
//	id:   工作副本 ID
//	path: 相对仓库根的路径
//
// Returns:
//
//	文件内容与元信息。越界、不存在、二进制或超过上限时返回错误。
func (s *WorkingCopyService) ReadText(id, path string) (FileText, error) {
	wc, err := s.get(id)
	if err != nil {
		return FileText{}, err
	}

	abs, err := resolveInside(wc.Path, path, false)
	if err != nil {
		return FileText{}, err
	}

	info, err := os.Stat(abs)
	if err != nil {
		return FileText{}, fmt.Errorf("读取文件失败: %w", err)
	}
	if info.IsDir() {
		return FileText{}, fmt.Errorf("这是一个目录，不是文件: %s", path)
	}
	if info.Size() > maxReadableBytes {
		return FileText{}, fmt.Errorf(
			"文件过大（%d KiB，上限 %d KiB）",
			info.Size()/1024, maxReadableBytes/1024,
		)
	}

	data, err := os.ReadFile(abs)
	if err != nil {
		return FileText{}, fmt.Errorf("读取文件失败: %w", err)
	}
	if !isTextContent(data) {
		return FileText{}, errors.New("这是一个二进制文件，不当作文本打开")
	}

	return FileText{
		Content: string(data),
		Mtime:   info.ModTime().UnixMilli(),
		Size:    info.Size(),
	}, nil
}

// WriteText 把编辑后的内容写回磁盘。
//
// Args:
//
//	id:           工作副本 ID
//	path:         相对仓库根的路径
//	content:      新的文件内容
//	expectedMtime: 读取时拿到的 mtime（Unix 纳秒）；传 0 表示不做冲突检测
//
// Returns:
//
//	写入后的 mtime，供前端更新基准值。
//	文件已被外部修改时返回 ErrFileChanged，写入不会发生。
//
// 冲突检测是这里存在的唯一理由：编辑器和用户自己的构建脚本、另一个编辑器
// 可能同时改同一个文件。发现不一致时**不写**，把这个决定交回给用户——
// 静默覆盖会丢掉别人（或自己刚才在别处）的修改，而且事后无从追溯。
//
// 写盘用"先写临时文件再改名"：直接截断写入的过程中崩溃，会留下一个
// 既不是旧内容也不是新内容的半截文件。
func (s *WorkingCopyService) WriteText(id, path, content string, expectedMtime int64) (int64, error) {
	wc, err := s.get(id)
	if err != nil {
		return 0, err
	}

	abs, err := resolveInside(wc.Path, path, false)
	if err != nil {
		return 0, err
	}

	if expectedMtime != 0 {
		info, statErr := os.Stat(abs)
		if statErr != nil {
			return 0, fmt.Errorf("读取文件状态失败: %w", statErr)
		}
		if info.ModTime().UnixMilli() != expectedMtime {
			return 0, fmt.Errorf("%w: %s", ErrFileChanged, path)
		}
	}

	// 保留原文件权限：改一个可执行脚本时不该把它的执行位弄丢。
	mode := os.FileMode(0o644)
	if info, statErr := os.Stat(abs); statErr == nil {
		mode = info.Mode().Perm()
	}

	if err := writeFileAtomic(abs, []byte(content), mode); err != nil {
		return 0, err
	}

	// 写盘成功后草稿立即作废：留着它，下次启动会把已经落盘的内容
	// 当成"待恢复的改动"再提一次，用户会以为自己的修改没保存。
	if clearErr := s.store.ClearBufferRecovery(id, path); clearErr != nil {
		return 0, clearErr
	}

	info, err := os.Stat(abs)
	if err != nil {
		return 0, fmt.Errorf("写入后读取状态失败: %w", err)
	}
	return info.ModTime().UnixMilli(), nil
}

// writeFileAtomic 原子地把内容写到目标路径。
//
// 临时文件放在同目录：跨文件系统的 rename 不是原子操作，会退化成复制。
func writeFileAtomic(abs string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(abs)
	tmp, err := os.CreateTemp(dir, ".kustos-*"+filepath.Ext(abs))
	if err != nil {
		return fmt.Errorf("创建临时文件失败: %w", err)
	}
	tmpName := tmp.Name()

	// 任何一步失败都要清掉临时文件，否则用户的仓库里会积攒垃圾。
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}

	if _, err := tmp.Write(data); err != nil {
		cleanup()
		return fmt.Errorf("写入临时文件失败: %w", err)
	}
	// 先落盘再改名：否则掉电后可能留下一个改名成功但内容还在页缓存里的文件。
	if err := tmp.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("同步临时文件失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("关闭临时文件失败: %w", err)
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("设置文件权限失败: %w", err)
	}
	if err := os.Rename(tmpName, abs); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("替换目标文件失败: %w", err)
	}
	return nil
}

// FileStat 返回仓库内某个文件的当前状态。
//
// 编辑器用它判断"磁盘上的文件是不是在我编辑期间变过"，
// 而不是每次保存都靠写盘失败来回退。
type FileStat struct {
	// Exists 表示文件当前是否还在。
	Exists bool `json:"exists"`
	// Mtime 是修改时间（Unix 毫秒）；文件不存在时为 0。
	Mtime int64 `json:"mtime"`
	// Size 是字节数。
	Size int64 `json:"size"`
}

// StatText 查询文件当前状态。
//
// Args:
//
//	id:   工作副本 ID
//	path: 相对仓库根的路径
//
// Returns:
//
//	文件状态。路径越界时返回错误；文件不存在不算错误（Exists 为 false）。
//
// 文件被删除是编辑过程中完全正常的情形，不该让前端的轮询变成一个错误。
func (s *WorkingCopyService) StatText(id, path string) (FileStat, error) {
	wc, err := s.get(id)
	if err != nil {
		return FileStat{}, err
	}
	abs, err := resolveInside(wc.Path, path, false)
	if err != nil {
		// 目标不存在是编辑过程中的正常情形（文件被删掉），不算查询失败；
		// 越界等其他错误才向上报告。
		if errors.Is(err, ErrPathNotFound) {
			return FileStat{Exists: false}, nil
		}
		return FileStat{}, err
	}

	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return FileStat{Exists: false}, nil
		}
		return FileStat{}, fmt.Errorf("读取文件状态失败: %w", err)
	}
	return FileStat{Exists: true, Mtime: info.ModTime().UnixMilli(), Size: info.Size()}, nil
}

// nowMillis 便于测试构造 mtime 基准值。
func nowMillis() int64 { return time.Now().UnixMilli() }

/* ------------------------------------------------------------------ */
/* 未保存 buffer 的崩溃恢复                                            */
/* ------------------------------------------------------------------ */

// BufferDraft 是一条尚未保存的编辑内容。
type BufferDraft struct {
	// Path 是相对仓库根的路径。
	Path string `json:"path"`
	// Content 是用户改动后的全文。
	Content string `json:"content"`
	// BaseMtime 是开始编辑时磁盘文件的修改时间，保存前用它检测冲突。
	BaseMtime int64 `json:"baseMtime"`
	// SavedAt 是最后一次记录的 Unix 秒时间戳。
	SavedAt int64 `json:"savedAt"`
}

// SaveDraft 记录一份未保存的编辑内容。
//
// Args:
//
//	id:      工作副本 ID
//	path:    相对仓库根的路径
//	content: 当前编辑器内容
//	baseMtime: 开始编辑时磁盘文件的修改时间
//
// Returns:
//
//	写入失败时返回错误。
//
// 前端在内容变化后去抖调用，因此这里必须便宜：一次 upsert，不做任何
// 文件系统操作。
func (s *WorkingCopyService) SaveDraft(id, path, content string, baseMtime int64) error {
	if _, err := s.get(id); err != nil {
		return err
	}
	return s.store.SaveBufferRecovery(store.BufferRecovery{
		WorkingCopyID: id,
		Path:          path,
		Content:       content,
		BaseMtime:     baseMtime,
	})
}

// ListDrafts 返回某个工作副本下所有未保存的内容。
//
// Returns:
//
//	按路径排序的草稿列表；没有记录时返回空切片。
//
// 只在需要恢复时调用（启动、切换工作副本），不做轮询。
func (s *WorkingCopyService) ListDrafts(id string) ([]BufferDraft, error) {
	rows, err := s.store.ListBufferRecoveries(id)
	if err != nil {
		return nil, err
	}
	list := make([]BufferDraft, 0, len(rows))
	for _, r := range rows {
		list = append(list, BufferDraft{
			Path:      r.Path,
			Content:   r.Content,
			BaseMtime: r.BaseMtime,
			SavedAt:   r.SavedAt,
		})
	}
	return list, nil
}

// DiscardDraft 放弃一份未保存的内容。
//
// 用户选择"放弃改动"或保存成功后调用。
func (s *WorkingCopyService) DiscardDraft(id, path string) error {
	if _, err := s.get(id); err != nil {
		return err
	}
	return s.store.ClearBufferRecovery(id, path)
}
