from app.core.db_url import sync_db_url
from app.utils.db_migrate import _make_alembic_config


def test_url_with_percent_is_escaped_for_configparser():
    """密码含 ! 时同步 URL 会变成 %21；configparser 不能因此抛插值错误。"""
    url = "postgresql://kustos:KXa!pwd@postgres:5432/kustos"
    expected = sync_db_url(url)
    assert "%" in expected

    cfg = _make_alembic_config(url)

    assert cfg.get_main_option("sqlalchemy.url") == expected


def test_url_without_percent_is_unchanged():
    """普通 URL 不受转义影响。"""
    url = "postgresql://kustos:plainpwd@postgres:5432/kustos"

    cfg = _make_alembic_config(url)

    assert cfg.get_main_option("sqlalchemy.url") == sync_db_url(url)
