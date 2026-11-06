package windowstate

import (
	"sync"
	"testing"
	"time"
)

// 拖动窗口时 move/resize 事件是连续高频的：一次拖拽能触发上百次。
// 每次直接写 SQLite 会造成写放大（且 SQLite 是单写者），因此必须去抖。
// 但去抖不能把最后一次改动吞掉——用户拖完就关窗口是最常见的路径。

func TestSaverCoalescesBurstIntoOneWrite(t *testing.T) {
	var mu sync.Mutex
	var writes []State

	s := NewSaver(func(st State) error {
		mu.Lock()
		defer mu.Unlock()
		writes = append(writes, st)
		return nil
	}, 30*time.Millisecond)

	for i := 0; i < 20; i++ {
		s.Schedule(State{X: i, Y: 0, Width: 1000, Height: 700})
	}
	if err := s.Flush(); err != nil {
		t.Fatalf("Flush 失败: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(writes) != 1 {
		t.Fatalf("一轮连续事件应合并为一次写入，实际 %d 次", len(writes))
	}
	if writes[0].X != 19 {
		t.Fatalf("应保存最后一次状态，实际 %+v", writes[0])
	}
}

// Flush 必须落盘：窗口关闭前调用它，不能因为"还在去抖窗口内"就丢掉最后的改动。
func TestSaverFlushWritesImmediately(t *testing.T) {
	var mu sync.Mutex
	count := 0

	s := NewSaver(func(State) error {
		mu.Lock()
		defer mu.Unlock()
		count++
		return nil
	}, time.Hour) // 去抖窗口设得极长，只有 Flush 才能写入

	s.Schedule(State{X: 5, Width: 1000, Height: 700})
	if err := s.Flush(); err != nil {
		t.Fatalf("Flush 失败: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if count != 1 {
		t.Fatalf("Flush 应立即写入一次，实际 %d 次", count)
	}
}

// 没有待写状态时 Flush 不应产生任何写入（例如启动后用户没动过窗口）。
func TestSaverFlushWithoutPendingIsNoop(t *testing.T) {
	count := 0
	s := NewSaver(func(State) error {
		count++
		return nil
	}, time.Hour)

	if err := s.Flush(); err != nil {
		t.Fatalf("Flush 失败: %v", err)
	}
	if count != 0 {
		t.Fatalf("无待写状态时不应写入，实际 %d 次", count)
	}
}

// 定时器到点后应自行写入，不依赖调用方再触发。
func TestSaverWritesAfterDelayWithoutFlush(t *testing.T) {
	done := make(chan State, 1)
	s := NewSaver(func(st State) error {
		done <- st
		return nil
	}, 20*time.Millisecond)

	s.Schedule(State{X: 7, Width: 1000, Height: 700})

	select {
	case got := <-done:
		if got.X != 7 {
			t.Fatalf("应保存最后一次状态，实际 %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("去抖窗口到期后应自动写入")
	}
}

// 关闭后再调度不应再写：进程正在退出，晚到的写入会与关闭竞争。
func TestSaverIgnoresScheduleAfterClose(t *testing.T) {
	count := 0
	var mu sync.Mutex
	s := NewSaver(func(State) error {
		mu.Lock()
		defer mu.Unlock()
		count++
		return nil
	}, 10*time.Millisecond)

	s.Schedule(State{X: 1, Width: 1000, Height: 700})
	s.Close()

	before := count
	s.Schedule(State{X: 2, Width: 1000, Height: 700})
	time.Sleep(60 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if count != before {
		t.Fatalf("Close 之后不应再写入，此前 %d 次、现在 %d 次", before, count)
	}
}

func TestSaverConcurrentScheduleIsSafe(t *testing.T) {
	var mu sync.Mutex
	count := 0
	s := NewSaver(func(State) error {
		mu.Lock()
		defer mu.Unlock()
		count++
		return nil
	}, 5*time.Millisecond)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s.Schedule(State{X: i, Width: 1000, Height: 700})
		}(i)
	}
	wg.Wait()

	if err := s.Flush(); err != nil {
		t.Fatalf("Flush 失败: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if count == 0 {
		t.Fatal("并发调度后至少应写入一次")
	}
}
