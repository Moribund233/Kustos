"""LFS 存储布局迁移脚本测试（幂等、可重入）"""
import sys
import uuid
from pathlib import Path

import pytest

from scripts.migrate_lfs_layout import main as migrate_main
from app.services.lfs.lfs_storage import LocalFSStorage


@pytest.fixture
def legacy_root(tmp_path: Path) -> Path:
    """造一份旧布局数据: {root}/{repo_id}/ab/cd/oid"""
    root = tmp_path / "lfs"
    repo_id = uuid.uuid4()
    oid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    legacy = root / str(repo_id) / "01" / "23" / oid
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(b"legacy-object-bytes")
    return root


def _run(monkeypatch, *argv: str) -> int:
    monkeypatch.setattr(sys, "argv", ["migrate_lfs_layout.py", *argv])
    return migrate_main()


class TestMigrateLfsLayout:
    def test_dry_run_does_not_touch_files(self, legacy_root, monkeypatch):
        before = list(legacy_root.rglob("*"))
        assert _run(monkeypatch, "--root", str(legacy_root), "--quiet") == 0
        assert list(legacy_root.rglob("*")) == before
        assert not (legacy_root / "objects").exists()

    def test_apply_moves_then_is_idempotent(self, legacy_root, monkeypatch):
        assert _run(monkeypatch, "--root", str(legacy_root), "--apply", "--quiet") == 0

        moved = list(legacy_root.rglob("objects/*/*/*"))
        assert len(moved) == 1
        assert moved[0].read_bytes() == b"legacy-object-bytes"
        # 旧分片目录已回收（注意 objects/ 下有同名新分片，只看仓库根）
        repo_dir = next(p for p in legacy_root.iterdir() if p.is_dir())
        assert not (repo_dir / "01").exists()

        # 再跑一次（可重入）：无事发生、退出码 0
        assert _run(monkeypatch, "--root", str(legacy_root), "--apply", "--quiet") == 0
        assert len(list(legacy_root.rglob("objects/*/*/*"))) == 1

    def test_storage_reads_migrated_object(self, legacy_root, monkeypatch):
        assert _run(monkeypatch, "--root", str(legacy_root), "--apply", "--quiet") == 0
        repo_id = next(p for p in legacy_root.iterdir() if p.is_dir()).name
        storage = LocalFSStorage(str(legacy_root), uuid.UUID(repo_id))
        oid = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        # oid 前缀 sha256: 与裸 hex 在存储层等价
        assert storage._resolve(oid).exists()
        assert storage._resolve("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").exists()

    def test_conflicting_target_is_not_overwritten(self, legacy_root, monkeypatch):
        """目标已存在但内容不同 → 跳过并告警（oid 为内容哈希，不一致即损坏）"""
        repo_dir = next(p for p in legacy_root.iterdir() if p.is_dir())
        oid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        target = repo_dir / "objects" / "01" / "23" / oid
        target.parent.mkdir(parents=True)
        target.write_bytes(b"other-content")

        assert _run(monkeypatch, "--root", str(legacy_root), "--apply") == 1
        # 两份都保留，未覆盖
        assert target.read_bytes() == b"other-content"
        assert (repo_dir / "01" / "23" / oid).read_bytes() == b"legacy-object-bytes"

    def test_unmappable_int_dir_is_left_alone(self, tmp_path, monkeypatch):
        """int→UUID 遗留的纯数字目录不触碰（无映射关系，交给人工）"""
        root = tmp_path / "lfs"
        legacy = root / "42" / "ab" / "cd" / "abcdef"
        legacy.parent.mkdir(parents=True)
        legacy.write_bytes(b"old")

        assert _run(monkeypatch, "--root", str(root), "--apply") == 1
        assert legacy.exists()
        assert not (root / "42" / "objects").exists()
