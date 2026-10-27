"""
Pytest配置文件

添加项目根目录到Python路径，使测试能够导入项目模块
提供测试用的共享fixture

架构说明：
- 统一使用 PostgreSQL：每个测试会话建一个临时库，结束时 DROP
- 同步和异步测试共享同一数据库，确保数据一致性
"""
import sys
import os

# 将项目根目录添加到Python路径
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

import uuid
from urllib.parse import urlsplit, urlunsplit

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from app.main import create_app, AppCache
from app.core.config import get_config, reset_module_config_manager
from app.core.db_url import canonical_db_url, sync_db_url
from app.models import Base
from app.services.token_service import create_access_token
from app.services.repository_service import _repo_exists_cache


# 统一测试数据库URL（由 test_engine fixture 在运行时填充）。
# PostgreSQL-only：每个测试会话建一个临时库、结束时 DROP。
TEST_DATABASE_URL = ""
TEST_ASYNC_URL = ""

# 临时 PG 库信息（会话结束回收）
_PG_TEMP = {"name": None, "admin_dsn": None}


def _normalize_pg_url(url: str) -> str:
    """去掉驱动后缀，得到标准 ``postgresql://`` 供解析/建库使用"""
    return canonical_db_url(url)


def _is_postgres_url(url: str | None) -> bool:
    return (url or "").lower().startswith(("postgresql://", "postgres://"))


def _create_temp_pg_database(base_url: str):
    """在 PG 服务上建一个唯一命名的临时库，返回 (name, admin_dsn, sync_url, async_url)"""
    import psycopg2

    parts = urlsplit(_normalize_pg_url(base_url))
    name = f"kustos_test_{uuid.uuid4().hex[:12]}"
    # 维护库固定用 postgres；建库需要 AUTOCOMMIT
    admin_dsn = urlunsplit(("postgresql", parts.netloc, "/postgres", "", ""))
    conn = psycopg2.connect(admin_dsn)
    try:
        conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
        with conn.cursor() as cur:
            cur.execute(f'CREATE DATABASE "{name}"')
    finally:
        conn.close()
    sync_url = urlunsplit(("postgresql+psycopg2", parts.netloc, f"/{name}", "", ""))
    async_url = urlunsplit(("postgresql+asyncpg", parts.netloc, f"/{name}", "", ""))
    return name, admin_dsn, sync_url, async_url


def _drop_temp_pg_database(admin_dsn: str, name: str) -> None:
    """删除临时库（FORCE 断开残留连接；幂等）"""
    import psycopg2

    conn = psycopg2.connect(admin_dsn)
    try:
        conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
        with conn.cursor() as cur:
            cur.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    finally:
        conn.close()


@pytest.fixture(scope="session", autouse=True)
def _force_nullpool_async_engine():
    """测试期异步引擎统一用 NullPool。

    pytest-asyncio 每个用例一个新事件循环，而 asyncpg 连接**不能跨事件循环复用**；
    生产用的 QueuePool 会把上一个 loop 的连接带到下一个 loop，触发
    ``got Future attached to a different loop``。NullPool 每次新建/关闭连接，
    彻底规避。
    """
    import app.models.async_db as async_db
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    original = async_db._create_async_engine_with_config

    def _factory():
        url = async_db._get_async_url(get_config().database.url)
        return create_async_engine(url, poolclass=NullPool, future=True)

    async_db._create_async_engine_with_config = _factory
    try:
        yield
    finally:
        async_db._create_async_engine_with_config = original


@pytest.fixture(scope="session")
def test_engine(_force_nullpool_async_engine):
    """创建测试数据库引擎（会话级别）。

    PostgreSQL-only：要求环境提供 ``DATABASE_URL`` / ``TEST_DATABASE_URL``。
    流程是建一个一次性临时库、启用 pgvector、建全部表，会话结束
    ``DROP DATABASE ... FORCE`` 回收。
    """
    global TEST_DATABASE_URL, TEST_ASYNC_URL

    base_url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not _is_postgres_url(base_url):
        raise RuntimeError(
            "测试需要 PostgreSQL：请设置 DATABASE_URL=postgresql://user:pass@host:5432/dbname"
            "（本项目不支持 SQLite）"
        )

    name, admin_dsn, sync_url, async_url = _create_temp_pg_database(base_url)
    _PG_TEMP.update(name=name, admin_dsn=admin_dsn)
    TEST_DATABASE_URL, TEST_ASYNC_URL = sync_url, async_url

    # 设置测试数据库URL环境变量（供应用配置读取，确保 app 用同一库）
    os.environ["DATABASE_URL"] = TEST_DATABASE_URL
    os.environ["KUSTOS_STRESS_TEST"] = "false"

    # 重置配置管理器
    reset_module_config_manager()

    engine = create_engine(TEST_DATABASE_URL, poolclass=NullPool, echo=False)
    with engine.begin() as conn:
        # pgvector 原生向量列依赖扩展（迁移在生产库建；测试库需显式启用）
        conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")

    # 创建所有表
    Base.metadata.create_all(bind=engine)

    yield engine

    # 清理：删除所有表并回收连接池
    Base.metadata.drop_all(bind=engine)
    engine.dispose()

    if _PG_TEMP["name"]:
        _drop_temp_pg_database(_PG_TEMP["admin_dsn"], _PG_TEMP["name"])
        _PG_TEMP.update(name=None, admin_dsn=None)


@pytest.fixture
def test_db_url(test_engine) -> str:
    """测试库的同步连接串（psycopg2 驱动），供需要直连引擎的用例使用"""
    return sync_db_url(TEST_DATABASE_URL)


@pytest.fixture
def isolated_db_url(test_engine):
    """一次性独立 PG 库（完整空库），用完即弃。

    供配置存储类用例使用：这些用例需要"改 DATABASE_URL 指向自己的库"
    来验证 env > DB > 默认值的优先级，不能共享会话主库。
    ``app_config`` 有指向 ``users`` 的外键，所以整库建表而不是单表。
    """
    name, admin_dsn, sync_url, _ = _create_temp_pg_database(os.environ["DATABASE_URL"])
    engine = create_engine(sync_url, poolclass=NullPool)
    try:
        with engine.begin() as conn:
            # 模型里有 pgvector 列（repo_search_embeddings），建表前需先开扩展
            conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")
        Base.metadata.create_all(engine)
        engine.dispose()
        yield sync_url
    finally:
        _drop_temp_pg_database(admin_dsn, name)


@pytest.fixture
def unreachable_db_url(test_engine) -> str:
    """格式合法但库名不存在的连接串：读库必失败，用于验证降级路径"""
    parts = urlsplit(canonical_db_url(os.environ["DATABASE_URL"]))
    name = f"kustos_absent_{uuid.uuid4().hex[:8]}"
    return urlunsplit(("postgresql+psycopg2", parts.netloc, f"/{name}", "", ""))


@pytest.fixture
def db(test_engine):
    """
    创建同步数据库会话

    每次测试后自动清理数据，确保测试隔离。

    Args:
        test_engine: 测试数据库引擎

    Yields:
        Session: 数据库会话
    """
    TestSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)
    session = TestSessionLocal()

    try:
        yield session
    finally:
        session.rollback()
        # 清理：使用同一会话删除所有表中的数据
        from app.models import Base
        for table in reversed(Base.metadata.sorted_tables):
            session.execute(table.delete())
        session.commit()
        session.close()
        # 清理物理仓库目录（测试间隔离）
        import shutil
        from app.core.config import get_config
        config = get_config()
        repo_root = config.storage.repo_root if hasattr(config, 'storage') else "./repositories"
        if repo_root and os.path.exists(repo_root):
            for item in os.listdir(repo_root):
                item_path = os.path.join(repo_root, item)
                if os.path.isdir(item_path):
                    shutil.rmtree(item_path)
                else:
                    os.remove(item_path)
        # 清理物理仓库存在状态缓存
        _repo_exists_cache.clear()


@pytest.fixture
def test_user(db):
    from app.models.user import User
    user = User(
        username="testuser",
        email="test@example.com",
        password="hashed_password_string",
        full_name="Test User",
        is_active=True,
        is_admin=False
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def admin_user(db):
    from app.models.user import User
    user = User(
        username="adminuser",
        email="admin@example.com",
        password="hashed_admin_password",
        full_name="Admin User",
        is_active=True,
        is_admin=True
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest_asyncio.fixture
async def async_db(test_engine):
    """
    创建异步数据库会话

    使用与同步测试相同的数据库文件，确保数据一致性。
    每次测试后自动清理数据，确保测试隔离。

    Args:
        test_engine: 测试数据库引擎

    Yields:
        AsyncSession: 异步数据库会话
    """
    from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

    # 创建异步引擎，指向同一数据库文件
    async_engine = create_async_engine(
        TEST_ASYNC_URL,
        echo=False,
        future=True
    )

    async_session = async_sessionmaker(
        async_engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autocommit=False,
        autoflush=False
    )

    async with async_session() as session:
        yield session
        # 回滚任何未提交的更改
        await session.rollback()

        # 清理：使用同一会话删除所有表中的数据，确保测试隔离
        from app.models import Base
        for table in reversed(Base.metadata.sorted_tables):
            await session.execute(table.delete())
        await session.commit()

    await async_engine.dispose()

    # 清理物理仓库目录（测试间隔离）
    import shutil
    from app.core.config import get_config
    config = get_config()
    repo_root = config.storage.repo_root if hasattr(config, 'storage') else "./repositories"
    if repo_root and os.path.exists(repo_root):
        for item in os.listdir(repo_root):
            item_path = os.path.join(repo_root, item)
            if os.path.isdir(item_path):
                shutil.rmtree(item_path)
            else:
                os.remove(item_path)

    # 清理物理仓库存在状态缓存
    _repo_exists_cache.clear()


@pytest.fixture
def test_client(test_engine):
    """
    创建测试客户端

    Args:
        test_engine: 测试数据库引擎

    Yields:
        TestClient: FastAPI测试客户端
    """
    # 重置应用缓存和配置管理器
    AppCache.reset()
    reset_module_config_manager()

    # 创建应用和测试客户端
    app = create_app()
    client = TestClient(app)

    yield client


@pytest.fixture
def auth_headers(test_user):
    """
    创建认证用的请求头

    使用 test_user fixture 生成访问令牌

    Returns:
        dict: 包含Authorization头的字典
    """
    from app.services.token_service import create_access_token

    token = create_access_token({
        "sub": str(test_user.id),
        "username": test_user.username,
        "is_admin": test_user.is_admin
    })

    return {
        "Authorization": f"Bearer {token}"
    }


@pytest.fixture
def admin_headers(admin_user):
    """
    创建管理员认证用的请求头

    Returns:
        dict: 包含Authorization头的字典
    """
    from app.services.token_service import create_access_token

    token = create_access_token({
        "sub": str(admin_user.id),
        "username": admin_user.username,
        "is_admin": admin_user.is_admin
    })

    return {
        "Authorization": f"Bearer {token}"
    }


# ============ 异步测试 Fixtures ============

@pytest_asyncio.fixture
async def async_test_user(async_db):
    """
    创建异步测试用户

    Args:
        async_db: 异步数据库会话

    Returns:
        User: 测试用户实例
    """
    from app.models.user import User

    user = User(
        username="async_testuser",
        email="async_test@example.com",
        password="hashed_password",
        full_name="Async Test User",
        is_active=True
    )
    async_db.add(user)
    await async_db.commit()
    await async_db.refresh(user)
    return user


@pytest_asyncio.fixture
async def async_test_user2(async_db):
    """创建第二个异步测试用户"""
    from app.models.user import User

    user = User(
        username="async_testuser2",
        email="async_test2@example.com",
        password="hashed_password",
        full_name="Async Test User 2",
        is_active=True
    )
    async_db.add(user)
    await async_db.commit()
    await async_db.refresh(user)
    return user


@pytest_asyncio.fixture
async def async_another_user(async_db):
    """创建另一个异步测试用户（用于权限测试）"""
    from app.models.user import User

    user = User(
        username="async_another",
        email="async_another@example.com",
        password="hashed_password",
        full_name="Another User",
        is_active=True
    )
    async_db.add(user)
    await async_db.commit()
    await async_db.refresh(user)
    return user


@pytest_asyncio.fixture
async def async_test_repo(async_db, async_test_user):
    """
    创建异步测试仓库

    Args:
        async_db: 异步数据库会话
        async_test_user: 异步测试用户

    Returns:
        Repository: 测试仓库实例
    """
    from app.models.repository import Repository

    repo = Repository(
        name="async-test-repo",
        description="Async Test repository",
        owner_id=async_test_user.id,
        is_public=True,
        path=f"{async_test_user.username}/async-test-repo"
    )
    async_db.add(repo)
    await async_db.commit()
    await async_db.refresh(repo)
    return repo


@pytest.fixture
def agent_enabled(monkeypatch):
    """开启内置 Agent（kill switch 默认关闭）。

    仅 Agent 相关测试显式请求本 fixture；其它测试保持默认关闭，验证 kill switch。
    """
    from app.core.config import get_config

    cfg = get_config().agent
    monkeypatch.setattr(cfg, "enabled", True, raising=False)
    monkeypatch.setattr(cfg, "allowed_base_urls", "", raising=False)
    return cfg


@pytest.fixture(scope="session", autouse=True)
def _lfs_storage_path():
    """LFS 存储统一落到临时目录。

    收敛为**全会话唯一**的 owner（此前由 ``test_lfs_api`` 模块级 fixture 持有，
    模块结束时会把环境变量清掉，跨模块使用 LFS 的测试会退回 ``/data/lfs``）。
    """
    import shutil
    import tempfile

    tmpdir = tempfile.mkdtemp(prefix="kustos_lfs_test_")
    old_value = os.environ.get("KUSTOS_LFS_LOCAL_PATH")
    os.environ["KUSTOS_LFS_LOCAL_PATH"] = tmpdir
    yield
    shutil.rmtree(tmpdir, ignore_errors=True)
    if old_value is not None:
        os.environ["KUSTOS_LFS_LOCAL_PATH"] = old_value
    else:
        os.environ.pop("KUSTOS_LFS_LOCAL_PATH", None)
