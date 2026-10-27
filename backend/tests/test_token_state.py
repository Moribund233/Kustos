"""撤销位图单层（services/token_state）+ refresh 轮换语义

覆盖：
- 位图 set/get 直查（无 DB 参与）
- Redis 可用走 Redis；不可用走内存兜底 + degraded 登记（口径）
- 轮换标记 SET NX（宽限期不重置首次时间戳）
- refresh 轮换：单次使用 + 宽限内重放放行 + 超宽限重用吊销 family
- 启动回填：RevokedToken 审计行 → 位图
"""
import time
import uuid
from datetime import datetime, timedelta, timezone

from app.services import token_service
import pytest

from app.core.exception import AuthenticationException
from app.models.revoked_token import RevokedToken
from app.services import token_state
from app.utils.degraded import registry as degraded


class _FakeRedis:
    def __init__(self):
        self.store = {}
        self.fail = False

    async def get(self, key):
        if self.fail:
            raise RuntimeError("redis down")
        return self.store.get(key)

    async def set(self, key, value, ex=None, nx=False):
        if self.fail:
            raise RuntimeError("redis down")
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    """每个用例：清内存兜底 + 清 degraded 登记；默认无 Redis（内存路径）"""
    token_state.reset_memory()
    degraded.reset()
    async def _none():
        return None
    monkeypatch.setattr(token_state, "get_redis", _none)
    yield
    token_state.reset_memory()
    degraded.reset()


@pytest.fixture
def fake_redis(monkeypatch):
    fake = _FakeRedis()
    async def _fake():
        return fake
    monkeypatch.setattr(token_state, "get_redis", _fake)
    return fake


# ========================================================================
# 位图本体
# ========================================================================

async def test_revoke_then_is_revoked_without_redis():
    """无 Redis：内存兜底使同 worker 撤销生效（非裸 fail-open）"""
    await token_state.revoke("token", "j1", ttl=60)
    assert await token_state.is_revoked("token", "j1") is True
    assert await token_state.is_revoked("token", "j2") is False


async def test_no_redis_registers_degraded():
    """Redis 不可用 → 显式登记 degraded（非静默），组件名 token_revocation"""
    await token_state.revoke("token", "j1", ttl=60)
    comps = [c["component"] for c in degraded.snapshot()]
    assert "token_revocation" in comps
    entry = next(c for c in degraded.snapshot() if c["component"] == "token_revocation")
    assert entry["mode"] == "memory"
    assert "本 worker" in entry["detail"]


async def test_redis_recovers_clears_degraded(fake_redis):
    """恢复自愈：Redis 故障时登记 degraded，恢复后下一次操作 clear（同 request_stats 模式）"""
    fake_redis.fail = True
    await token_state.revoke("token", "j1", ttl=60)
    assert degraded.degraded is True

    fake_redis.fail = False
    await token_state.revoke("token", "j2", ttl=60)
    assert degraded.degraded is False


async def test_redis_write_failure_falls_back_to_memory(fake_redis):
    """Redis 写异常 → 内存兜底仍生效 + degraded 登记"""
    fake_redis.fail = True
    await token_state.revoke("token", "j1", ttl=60)
    assert await token_state.is_revoked("token", "j1") is True
    assert degraded.degraded is True


async def test_redis_is_primary_when_available(fake_redis):
    """Redis 可用：写 Redis、读 Redis（跨 worker 可见的主后端）"""
    await token_state.revoke("token", "j1", ttl=60)
    assert "revoked:token:j1" in fake_redis.store or any(
        k.endswith("revoked:token:j1") for k in fake_redis.store
    )
    # 内存镜像同样存在（写穿）
    assert await token_state.is_revoked("token", "j1") is True


async def test_mem_only_hit_survives_redis_restart(fake_redis):
    """Redis 故障窗口内本 worker 的写：Redis 恢复后若键丢失，内存镜像仍拦（union 读）"""
    fake_redis.fail = True
    await token_state.revoke("token", "j1", ttl=60)
    fake_redis.fail = False
    fake_redis.store.clear()  # 模拟 Redis 重启丢键
    assert await token_state.is_revoked("token", "j1") is True


async def test_expired_ttl_not_revoked():
    """TTL 过期自失效（位图键寿命 = token 剩余寿命）"""
    await token_state.revoke("token", "j1", ttl=60)
    # 手动把内存条目过期掉（模拟 TTL 到期）
    for k in list(token_state._mem):
        if k.endswith("revoked:token:j1"):
            v, _ = token_state._mem[k]
            token_state._mem[k] = (v, time.time() - 1)
    assert await token_state.is_revoked("token", "j1") is False


# ========================================================================
# 轮换标记（SET NX）
# ========================================================================

async def test_mark_rotated_nx_keeps_first_timestamp(fake_redis):
    """宽限期以首次轮换为准：重复 mark 不重置时间戳（防连续重放驻留宽限窗口）"""
    await token_state.mark_rotated("j1", ttl=60)
    first = await token_state.get_rotated("j1")
    assert first is not None
    # 人为回拨时间戳再 mark —— NX 应不覆盖
    key = token_state._key("rotated", "j1")
    token_state._mem[key] = ("1000.0", time.time() + 60)
    fake_redis.store[key if key in fake_redis.store else next(
        k for k in fake_redis.store if k.endswith("rotated:j1"))] = "1000.0"
    await token_state.mark_rotated("j1", ttl=60)
    assert await token_state.get_rotated("j1") == 1000.0


async def test_get_rotated_none_when_not_rotated():
    assert await token_state.get_rotated("never") is None


async def test_rotated_marker_expires_with_ttl(fake_redis):
    await token_state.mark_rotated("j1", ttl=60)
    key = next(k for k in fake_redis.store if k.endswith("rotated:j1"))
    v, _ = token_state._mem[key]
    token_state._mem[key] = (v, time.time() - 1)
    fake_redis.store.pop(key)
    assert await token_state.get_rotated("j1") is None


# ========================================================================
# token_service 接线：verify_token_active / revoke / backfill
# ========================================================================

async def test_verify_token_active_checks_bitmap_only(async_db):
    """热路径只查位图：未撤销 → 通过；不碰 DB（db 参数已不存在）"""
    token = token_service.create_access_token(
        {"sub": str(uuid.uuid4()), "username": "u"}
    )
    data = await token_service.verify_token_active(token)
    assert data is not None


async def test_revoke_writes_bitmap_and_audit_row(async_db, async_test_user):
    """revoke_token 双写：位图（热路径）+ RevokedToken 行（审计/回填源）"""
    from sqlalchemy import select
    token = token_service.create_access_token(
        {"sub": str(async_test_user.id), "username": async_test_user.username}
    )
    data = token_service.verify_token(token)
    assert await token_service.revoke_token(async_db, token) is True
    assert await token_service.is_token_revoked(data.jti) is True
    rows = (await async_db.execute(
        select(RevokedToken).filter(RevokedToken.jti == data.jti)
    )).scalars().all()
    assert len(rows) == 1
    assert rows[0].token_type == "access"


async def test_backfill_restores_from_audit_rows(async_db):
    """启动回填：DB 审计行（Redis 丢失后）→ 位图；过期行不回填"""
    now = datetime.now(timezone.utc)
    async_db.add(RevokedToken(jti="live-jti", token_type="access",
                              expires_at=now + timedelta(hours=1)))
    async_db.add(RevokedToken(jti="dead-jti", token_type="access",
                              expires_at=now - timedelta(minutes=1)))
    async_db.add(RevokedToken(jti="fam-1", token_type="family",
                              expires_at=now + timedelta(days=7)))
    await async_db.commit()

    count = await token_service.backfill_revocations(async_db)
    assert count == 2
    assert await token_state.is_revoked("token", "live-jti") is True
    assert await token_state.is_revoked("token", "dead-jti") is False
    assert await token_state.is_revoked("family", "fam-1") is True


async def test_revoke_family_dual_write(async_db):
    """family 吊销：位图 + 审计行（token_type='family'）"""
    from sqlalchemy import select
    fam = uuid.uuid4().hex
    assert await token_service.revoke_family(async_db, fam) is True
    assert await token_state.is_revoked("family", fam) is True
    rows = (await async_db.execute(
        select(RevokedToken).filter(RevokedToken.jti == fam)
    )).scalars().all()
    assert len(rows) == 1
    assert rows[0].token_type == "family"
    # 幂等
    assert await token_service.revoke_family(async_db, fam) is True


# ========================================================================
# refresh 轮换（单次使用 + 宽限 + 重用吊销）
# ========================================================================

def _user_token_pair(user):
    return token_service.create_token_pair(user)


async def test_refresh_rotates_single_use(async_db, async_test_user):
    """refresh 使用一次后旧 refresh 失效（宽限期外）"""
    tokens = _user_token_pair(async_test_user)
    old_refresh = tokens["refresh_token"]

    new_tokens = await token_service.refresh_access_token(old_refresh, async_db)
    assert new_tokens["refresh_token"] != old_refresh
    # 新对 family 沿用（同一次登录会话）
    old_data = token_service.verify_token(old_refresh, token_type="refresh")
    new_data = token_service.verify_token(new_tokens["refresh_token"], token_type="refresh")
    assert old_data.family_id is not None
    assert new_data.family_id == old_data.family_id

    # 模拟宽限期过（直接改轮换时间戳为 61s 前）
    key = token_state._key("rotated", old_data.jti)
    v, exp = token_state._mem[key]
    token_state._mem[key] = (str(time.time() - 61), exp)

    from app.core.exception import AuthenticationException
    with pytest.raises(AuthenticationException):
        await token_service.refresh_access_token(old_refresh, async_db)


async def test_refresh_grace_window_allows_replay(async_db, async_test_user):
    """宽限期内重放放行（多标签页竞态），且不重置首次计时"""
    tokens = _user_token_pair(async_test_user)
    old_refresh = tokens["refresh_token"]

    first = await token_service.refresh_access_token(old_refresh, async_db)
    # 60s 内第二次用同一旧 token —— 放行
    second = await token_service.refresh_access_token(old_refresh, async_db)
    assert first["refresh_token"] != old_refresh
    assert second["refresh_token"] != old_refresh

    old_data = token_service.verify_token(old_refresh, token_type="refresh")
    rotated_at = await token_state.get_rotated(old_data.jti)
    # 时间戳是第一次轮换时写入的（NX），未被第二次重置
    assert rotated_at is not None


async def test_refresh_reuse_revokes_family(async_db, async_test_user):
    """超宽限重用 → 吊销整个 family（后续新 refresh 也失效）"""
    tokens = _user_token_pair(async_test_user)
    old_refresh = tokens["refresh_token"]
    old_data = token_service.verify_token(old_refresh, token_type="refresh")
    family_id = old_data.family_id

    new_tokens = await token_service.refresh_access_token(old_refresh, async_db)
    new_refresh = new_tokens["refresh_token"]

    # 超宽限：回拨轮换时间戳
    key = token_state._key("rotated", old_data.jti)
    v, exp = token_state._mem[key]
    token_state._mem[key] = (str(time.time() - 61), exp)

    from app.core.exception import AuthenticationException
    with pytest.raises(AuthenticationException):
        await token_service.refresh_access_token(old_refresh, async_db)

    # family 已吊销 → 换发出来的「新」refresh 也立即失效
    assert await token_state.is_revoked("family", family_id) is True
    with pytest.raises(AuthenticationException):
        await token_service.refresh_access_token(new_refresh, async_db)


async def test_refresh_rejected_when_family_revoked_by_logout(async_db, async_test_user):
    """登出吊销 family 后，链上任何 refresh 均 401"""
    tokens = _user_token_pair(async_test_user)
    refresh = tokens["refresh_token"]
    data = token_service.verify_token(refresh, token_type="refresh")
    await token_service.revoke_family(async_db, data.family_id)

    from app.core.exception import AuthenticationException
    with pytest.raises(AuthenticationException):
        await token_service.refresh_access_token(refresh, async_db)


async def test_refresh_legacy_token_without_family(async_db, async_test_user):
    """存量 token（无 family_id claim）：轮换正常，换发后进入 family 体系"""
    legacy = token_service.create_refresh_token(
        {"sub": str(async_test_user.id), "username": async_test_user.username}
    )
    legacy_data = token_service.verify_token(legacy, token_type="refresh")
    assert legacy_data.family_id is None

    new_tokens = await token_service.refresh_access_token(legacy, async_db)
    new_data = token_service.verify_token(new_tokens["refresh_token"], token_type="refresh")
    assert new_data.family_id is not None  # 新对自动进入 family


async def test_refresh_inactive_user(async_db, async_test_user):
    """未激活用户刷新 → user_not_found_inactive"""
    async_test_user.is_active = False
    await async_db.commit()
    tokens = _user_token_pair(async_test_user)
    from app.core.exception import AuthenticationException
    with pytest.raises(AuthenticationException) as ei:
        await token_service.refresh_access_token(tokens["refresh_token"], async_db)
    assert ei.value.error_code == "user_not_found_inactive"


async def test_refresh_jti_revoked(async_db, async_test_user):
    """按 jti 撤销（登出未带 family 的旧 token）→ 401"""
    tokens = _user_token_pair(async_test_user)
    refresh = tokens["refresh_token"]
    await token_service.revoke_token(async_db, refresh, token_type="refresh")
    from app.core.exception import AuthenticationException
    with pytest.raises(AuthenticationException):
        await token_service.refresh_access_token(refresh, async_db)


# ========================================================================
# 热路径查询计数（每请求认证 DB 查询 3 → 1）
# ========================================================================

async def test_get_current_user_single_db_query(async_db, async_test_user):
    """get_current_user 热路径 = 恰好 1 条 SELECT users（撤销不回源 DB）"""
    from fastapi.security import HTTPAuthorizationCredentials
    from sqlalchemy import event

    from app.api.deps import get_current_user

    token = token_service.create_access_token(
        {"sub": str(async_test_user.id), "username": async_test_user.username}
    )
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)

    engine = async_db.bind.sync_engine
    statements = []

    def _count(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", _count)
    try:
        user = await get_current_user(creds, db=async_db)
    finally:
        event.remove(engine, "before_cursor_execute", _count)

    assert user.id == async_test_user.id
    selects = [s for s in statements if s.strip().upper().startswith("SELECT")]
    assert len(selects) == 1, f"热路径应恰好 1 次用户查询，实际: {selects}"
    assert "revoked_tokens" not in " ".join(selects).lower()


async def test_verify_token_active_zero_db_query(async_db):
    """verify_token_active 本体 0 DB 查询（位图直查，签名已无 db 参数）"""
    import inspect

    from sqlalchemy import event

    sig = inspect.signature(token_service.verify_token_active)
    assert "db" not in sig.parameters  # 结构性保证：拿不到 session 就查不了 DB

    token = token_service.create_access_token(
        {"sub": str(uuid.uuid4()), "username": "u"}
    )
    engine = async_db.bind.sync_engine
    statements = []

    def _count(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", _count)
    try:
        assert await token_service.verify_token_active(token) is not None
    finally:
        event.remove(engine, "before_cursor_execute", _count)
    assert statements == [], f"verify_token_active 不应执行 SQL，实际: {statements}"


# ========================================================================
# get_optional_user 坏 token 语义（无头→None / 坏 token→401）
# ========================================================================

async def test_optional_user_no_header_returns_none(async_db):
    """无 Authorization 头 → None（匿名访问者，不抛错）"""
    from app.api.deps import get_optional_user

    assert await get_optional_user(credentials=None, db=async_db) is None


async def test_optional_user_bad_token_raises_401(async_db):
    """坏 token → 401 invalid_token（不得静默降级为匿名，否则私仓请求
    会得到语义错误的 403 而非 401）"""
    from app.api.deps import get_optional_user
    from fastapi.security import HTTPAuthorizationCredentials

    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="garbage-token-123")
    with pytest.raises(AuthenticationException) as ei:
        await get_optional_user(credentials=creds, db=async_db)
    assert ei.value.status_code == 401
    assert ei.value.error_code == "invalid_token"


async def test_optional_user_unknown_user_raises_401(async_db):
    """签名/状态校验通过但用户不存在 → 401 user_not_found"""
    from app.api.deps import get_optional_user
    from fastapi.security import HTTPAuthorizationCredentials

    token = token_service.create_access_token(
        {"sub": str(uuid.uuid4()), "username": "ghost"}
    )
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    with pytest.raises(AuthenticationException) as ei:
        await get_optional_user(credentials=creds, db=async_db)
    assert ei.value.status_code == 401
    assert ei.value.error_code == "user_not_found"


async def test_optional_user_inactive_raises_401(async_db, async_test_user):
    """已停用用户 → 401 user_inactive（与 get_current_user 同口径）"""
    from app.api.deps import get_optional_user
    from fastapi.security import HTTPAuthorizationCredentials

    async_test_user.is_active = False
    await async_db.commit()

    token = token_service.create_access_token(
        {"sub": str(async_test_user.id), "username": async_test_user.username}
    )
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    with pytest.raises(AuthenticationException) as ei:
        await get_optional_user(credentials=creds, db=async_db)
    assert ei.value.status_code == 401
    assert ei.value.error_code == "user_inactive"
