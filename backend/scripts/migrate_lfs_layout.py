#!/usr/bin/env python3
"""LFS 存储布局迁移：{root}/{repo_id}/ab/cd/oid → {root}/{repo_id}/objects/ab/cd/oid

定稿的存储布局要求「路径带 repo 维度 + objects 段」。本地后端自引入
起即按 repo 分目录，缺的只是 ``objects/`` 段；本脚本把存量对象平移到新布局。

特性（幂等、可重入）：

- 默认 **dry-run**，只报告将要移动的文件；加 ``--apply`` 才真正执行；
- 目标已存在且尺寸一致 → 删除源文件（去重收尾）；不一致 → 跳过并告警
  （oid 是内容哈希，不一致说明有损坏副本，绝不覆盖）；
- 中断后重跑安全：已移动的文件不会再次出现，未移动的继续处理；
- ``LocalFSStorage`` 读路径带旧布局回退，迁移期间下载不中断；
  迁移完成后删除回退（见 ``services/lfs_storage.py::_get_legacy_path``）；
- int→UUID 迁移留下的纯数字仓库目录**无法自动映射**，一律跳过并告警
  （退出码非 0），由人工确认后手动搬迁。

用法::

    python scripts/migrate_lfs_layout.py            # dry-run（打印统计与明细）
    python scripts/migrate_lfs_layout.py --apply    # 执行移动
    python scripts/migrate_lfs_layout.py --root /data/lfs --apply
"""
import argparse
import sys
from pathlib import Path


def _is_shard(name: str) -> bool:
    """hash 分片目录名（两位十六进制）"""
    return len(name) == 2 and all(c in "0123456789abcdef" for c in name.lower())


def _looks_like_repo_dir(repo_dir: Path) -> bool:
    """仓库维度目录：UUID（36 位含连字符）或 8+ 位十六进制 id"""
    name = repo_dir.name
    if len(name) == 36 and name.count("-") == 4:
        return True
    return len(name) >= 8 and all(c in "0123456789abcdef" for c in name.lower())


def iter_repo_dirs(root: Path):
    """root 下的仓库维度目录（跳过不属于布局的文件）"""
    if not root.is_dir():
        return
    for repo_dir in sorted(root.iterdir()):
        if repo_dir.is_dir() and repo_dir.name != "objects":
            yield repo_dir


def iter_legacy_objects(repo_dir: Path):
    """枚举单个仓库目录内旧布局的对象文件，产出 (源文件, 目标文件)"""
    target_root = repo_dir / "objects"
    for first in sorted(repo_dir.iterdir()):
        if not first.is_dir() or first.name == "objects" or not _is_shard(first.name):
            continue
        for second in sorted(first.iterdir()):
            if not second.is_dir() or not _is_shard(second.name):
                continue
            for obj in sorted(second.iterdir()):
                if obj.is_file():
                    yield obj, target_root / first.name / second.name / obj.name


def _cleanup_empty_shards(source: Path) -> None:
    for empty in (source.parent, source.parent.parent):
        try:
            empty.rmdir()
        except OSError:
            break


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", help="LFS 存储根目录（缺省读配置 lfs.local_path）")
    parser.add_argument("--apply", action="store_true",
                        help="真正执行移动（缺省 dry-run）")
    parser.add_argument("--quiet", action="store_true", help="只输出统计")
    args = parser.parse_args()

    root = args.root
    if not root:
        from app.core.config import get_config
        root = get_config().lfs.local_path
    root = Path(root)

    moved = skipped = deduped = unmappable = 0
    for repo_dir in iter_repo_dirs(root):
        if not _looks_like_repo_dir(repo_dir):
            unmappable += 1
            print(f"  [warn] 无法映射的仓库目录（int→UUID 遗留，需人工处理）: {repo_dir}",
                  file=sys.stderr)
            continue

        for source, target in iter_legacy_objects(repo_dir):
            if target.exists():
                if target.stat().st_size == source.stat().st_size:
                    if args.apply:
                        source.unlink()
                    deduped += 1
                    if not args.quiet:
                        print(f"  [dedupe] {source} -> 目标已存在同尺寸对象，删除源文件")
                else:
                    skipped += 1
                    print(f"  [warn] 尺寸不一致，跳过（保留两份，需人工核对）: {source}",
                          file=sys.stderr)
                continue

            if not args.quiet:
                print(f"  [{'move' if args.apply else 'would move'}] {source} -> {target}")
            if args.apply:
                target.parent.mkdir(parents=True, exist_ok=True)
                source.replace(target)
                _cleanup_empty_shards(source)
            moved += 1

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] root={root} moved={moved} deduped={deduped} "
          f"skipped={skipped} unmappable={unmappable}")
    if not args.apply and moved:
        print("加 --apply 执行移动")
    return 0 if skipped == 0 and unmappable == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())