package windowstate

import (
	"sync"
	"time"
)

// Saver 是把窗口状态的连续变更合并成稀疏写入的去抖器。
//
// 为什么需要：拖动窗口时 move/resize 事件一次拖拽可触发上百次，
// 每次都写 SQLite 是明显的写放大（SQLite 单写者，还会与其它窗口的
// 写入争锁）。去抖把一轮连续变更压成一次写入。
//
// 但去抖有一个陷阱：用户拖完窗口立刻关闭应用时，最后一次变更可能
// 还在等待窗口内。因此关闭前必须调用 Flush，而不是只依赖定时器。
type Saver struct {
	save    func(State) error
	delay   time.Duration
	mu      sync.Mutex
	pending *State
	timer   *time.Timer
	closed  bool
}

// NewSaver 构造去抖保存器。
//
// Args:
//
//	save:  实际的写入函数（通常是绑定到某个 key 的闭包）
//	delay: 去抖窗口；窗口内的多次 Schedule 只保留最后一次
//
// Returns:
//
//	可直接使用的保存器。调用方在退出前应调用 Flush 或 Close。
func NewSaver(save func(State) error, delay time.Duration) *Saver {
	if delay <= 0 {
		delay = 150 * time.Millisecond
	}
	return &Saver{save: save, delay: delay}
}

// Schedule 登记一次待保存的状态。
//
// 同一窗口内的多次调用只保留最后一次；已经有一个待写状态时不再重置
// 定时器，避免连续拖动把写入无限推迟（用户一直拖着不放，就永远不落盘）。
func (s *Saver) Schedule(st State) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.pending = &st
	if s.timer == nil {
		s.timer = time.AfterFunc(s.delay, s.fire)
	}
}

// fire 是定时器回调：取出待写状态并写入。
func (s *Saver) fire() {
	s.mu.Lock()
	if s.closed || s.pending == nil {
		s.timer = nil
		s.mu.Unlock()
		return
	}
	st := *s.pending
	s.pending = nil
	s.timer = nil
	s.mu.Unlock()

	// 在锁外写入：SQLite 写可能耗时，持锁会阻塞事件回调线程。
	_ = s.save(st)
}

// Flush 立即写入待保存的状态。
//
// Returns:
//
//	写入失败时返回错误；没有待写状态时返回 nil 且不产生写入。
func (s *Saver) Flush() error {
	s.mu.Lock()
	if s.pending == nil {
		s.mu.Unlock()
		return nil
	}
	st := *s.pending
	s.pending = nil
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.mu.Unlock()

	return s.save(st)
}

// Close 停止接受新的调度并释放定时器。
//
// 不在这里隐式 Flush：调用方需要明确区分"关闭前把最后的改动写下去"
// 和"放弃未写状态"，让这两件事共用一个入口会掩盖调用顺序的错误。
func (s *Saver) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}
