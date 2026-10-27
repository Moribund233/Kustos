"""
数据库 URL 归一化测试

回归保护：SQLAlchemy 2.1 起 `postgresql://` 的默认 DBAPI 变为 psycopg3，而本项目依赖
psycopg2，因此同步/迁移路径必须显式固定 `postgresql+psycopg2://`；异步路径固定
`postgresql+asyncpg://`。所有归一化都收敛在 `app.core.db_url`，禁止再各处拼字符串。
"""
import pytest

from app.core.db_url import async_db_url, canonical_db_url, parse_db_url, sync_db_url

PG = "postgresql://u:p@h:5432/d"
PG_ASYNC = "postgresql+asyncpg://u:p@h:5432/d"


def test_sync_url_normalized():
    assert sync_db_url(PG) == "postgresql+psycopg2://u:p@h:5432/d"
    assert sync_db_url(PG_ASYNC) == "postgresql+psycopg2://u:p@h:5432/d"
    assert sync_db_url("postgres://u:p@h:5432/d") == "postgresql+psycopg2://u:p@h:5432/d"
    assert sync_db_url("postgresql+psycopg2://u:p@h:5432/d") == "postgresql+psycopg2://u:p@h:5432/d"


def test_async_url_normalized():
    assert async_db_url(PG) == "postgresql+asyncpg://u:p@h:5432/d"
    assert async_db_url(PG_ASYNC) == "postgresql+asyncpg://u:p@h:5432/d"
    assert async_db_url("postgres://u:p@h:5432/d") == "postgresql+asyncpg://u:p@h:5432/d"


def test_canonical_url_strips_driver():
    assert canonical_db_url(PG) == "postgresql://u:p@h:5432/d"
    assert canonical_db_url(PG_ASYNC) == "postgresql://u:p@h:5432/d"


def test_query_params_and_password_preserved():
    """密码特殊字符与查询参数必须原样保留（这是字符串 replace 做不到的）。

    注意 SQLAlchemy 会把查询参数按 key 排序后输出，此处只断言语义等价。
    """
    url = "postgresql://user:p%40ss@h:5432/d?sslmode=require&application_name=kustos"
    out = sync_db_url(url)
    assert out.startswith("postgresql+psycopg2://user:p%40ss@h:5432/d?")
    assert set(out.split("?", 1)[1].split("&")) == {"sslmode=require", "application_name=kustos"}


def test_password_not_masked():
    """``str(URL)`` 会把密码打成 ``***``：归一化结果必须显式渲染，不得泄漏掩码"""
    url = "postgresql://user:secret@h:5432/d"
    assert sync_db_url(url) == "postgresql+psycopg2://user:secret@h:5432/d"
    assert async_db_url(url) == "postgresql+asyncpg://user:secret@h:5432/d"
    assert canonical_db_url(url) == "postgresql://user:secret@h:5432/d"


@pytest.mark.parametrize("bad", [
    "sqlite:///./x.db",
    "sqlite+aiosqlite:///./x.db",
    "mysql://u:p@h/d",
    "",
    "   ",
    "not a url",
])
def test_non_postgres_rejected(bad):
    with pytest.raises(ValueError):
        parse_db_url(bad)
