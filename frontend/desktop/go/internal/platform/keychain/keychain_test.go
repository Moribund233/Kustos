package keychain

import (
	"errors"
	"testing"
)

// 降级语义是这一层最容易被改坏的地方：看起来"只是回退到内存"，
// 但一旦降级标志算错，用户会在重启后莫名失联，或把凭据写进了
// 本该安全存储的明文位置。

type failingStore struct{ err error }

func (f failingStore) Set(string, string) error   { return f.err }
func (f failingStore) Get(string) (string, error) { return "", f.err }
func (f failingStore) Delete(string) error        { return f.err }
func (f failingStore) Persistent() bool           { return true }

func TestMemoryStoreRoundTrip(t *testing.T) {
	s := NewMemoryStore()

	if _, err := s.Get("missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("未命中应返回 ErrNotFound，实际 %v", err)
	}
	if err := s.Set("k", "v"); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if got, err := s.Get("k"); err != nil || got != "v" {
		t.Fatalf("读取 = %q, %v", got, err)
	}
	if err := s.Delete("k"); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if _, err := s.Get("k"); !errors.Is(err, ErrNotFound) {
		t.Fatal("删除后应查不到")
	}
}

func TestMemoryStoreNotPersistent(t *testing.T) {
	if NewMemoryStore().Persistent() {
		t.Fatal("内存存储不应声称持久")
	}
}

// 系统钥匙串可用时不应降级。
func TestCompositeUsesSystemWhenAvailable(t *testing.T) {
	system := NewMemoryStore()
	c := NewCompositeWith(system, NewMemoryStore())

	if err := c.Set("k", "v"); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if !c.Persistent() {
		t.Fatal("系统存储可用时不应降级")
	}
	if got, _ := system.Get("k"); got != "v" {
		t.Fatalf("应写入系统存储，实际 %q", got)
	}
}

// 系统钥匙串不可用时必须降级而不是让用户无法登录。
func TestCompositeFallsBackToMemory(t *testing.T) {
	c := NewCompositeWith(failingStore{err: errors.New("no secret service")}, NewMemoryStore())

	if err := c.Set("k", "v"); err != nil {
		t.Fatalf("降级后仍应写入成功: %v", err)
	}
	if c.Persistent() {
		t.Fatal("已降级时不应声称持久")
	}

	degraded, reason := c.Degraded()
	if !degraded || reason == nil {
		t.Fatal("降级必须可观测，并带原因")
	}
}

// 降级后读也要走内存，否则用户会"写进去了但读不出来"。
func TestCompositeReadsMemoryAfterDegrade(t *testing.T) {
	c := NewCompositeWith(failingStore{err: errors.New("boom")}, NewMemoryStore())

	_ = c.Set("k", "v")
	got, err := c.Get("k")
	if err != nil {
		t.Fatalf("降级后读取失败: %v", err)
	}
	if got != "v" {
		t.Fatalf("读取 = %q", got)
	}
}

// 未降级时 Get 到不存在的键，应是 ErrNotFound 而不是触发降级。
// 混淆这两者会让"首次登录"被误判成"钥匙串不可用"。
func TestCompositeNotFoundDoesNotDegrade(t *testing.T) {
	c := NewCompositeWith(NewMemoryStore(), NewMemoryStore())

	if _, err := c.Get("absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("应返回 ErrNotFound，实际 %v", err)
	}
	if degraded, _ := c.Degraded(); degraded {
		t.Fatal("未命中不应触发降级")
	}
	if !c.Persistent() {
		t.Fatal("未降级时仍应声称持久")
	}
}

// 删除要两处都清，避免降级前后残留副本。
func TestCompositeDeleteClearsBoth(t *testing.T) {
	system, memory := NewMemoryStore(), NewMemoryStore()
	c := NewCompositeWith(system, memory)

	_ = system.Set("k", "old")
	_ = memory.Set("k", "new")
	if err := c.Delete("k"); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if _, err := system.Get("k"); !errors.Is(err, ErrNotFound) {
		t.Error("系统存储残留")
	}
	if _, err := memory.Get("k"); !errors.Is(err, ErrNotFound) {
		t.Error("内存存储残留")
	}
}
