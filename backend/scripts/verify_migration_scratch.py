"""迁移 scratch 验证（一次性运维脚本）——可重复执行。

在 scratch PG 库上验证当前 head 的 upgrade → downgrade → re-upgrade 幂等链。
密码不经过 shell：直接复用 test 容器内 compose 已插值好的 DATABASE_URL，
仅把库名替换为 scratch 库（默认 kustos_migrate_scratch，可用 SCRATCH_DB 覆盖）。

用法（test 容器内）：
    python scripts/verify_migration_scratch.py
"""
import os
import sys
from urllib.parse import urlsplit, urlunsplit

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from alembic import command

from app.utils.db_migrate import _make_alembic_config, get_applied_revision, get_head_revision


def scratch_url() -> str:
    """基于容器内 DATABASE_URL 派生 scratch 库 URL（保留主机/密码，仅换库名）"""
    raw = os.environ["DATABASE_URL"]
    scratch_db = os.environ.get("SCRATCH_DB", "kustos_migrate_scratch")
    parts = urlsplit(raw)
    path = "/" + scratch_db
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))


def main() -> int:
    url = scratch_url()
    print(f"[0/4] scratch url (密码已隐去): {url.split('@')[0].split('//')[0]}://***@{url.split('@')[1] if '@' in url else url}")
    head = get_head_revision(url)
    print(f"[1/4] head = {head}")

    cfg = _make_alembic_config(url)
    command.upgrade(cfg, "head")
    applied = get_applied_revision(url)
    print(f"[2/4] upgrade → {applied}")
    assert applied == head, f"upgrade 后版本 {applied} != head {head}"

    cfg = _make_alembic_config(url)
    command.downgrade(cfg, "-1")
    applied = get_applied_revision(url)
    print(f"[3/4] downgrade -1 → {applied}")

    cfg = _make_alembic_config(url)
    command.upgrade(cfg, "head")
    applied = get_applied_revision(url)
    print(f"[4/4] re-upgrade → {applied}")
    assert applied == head, f"二次 upgrade 后版本 {applied} != head {head}"

    print("PASS: upgrade/downgrade/re-upgrade 幂等链验证通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
