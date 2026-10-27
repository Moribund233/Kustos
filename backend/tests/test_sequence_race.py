"""
编号分配并发竞态回归测试

背景：``get_next_sequence_number`` 原实现是 ``SELECT max()+1``，两个并发
创建会拿到同一编号，而旧 schema 的 (repository_id, number) 无唯一约束
→ 静默产生重复 PR/Issue 编号，前端 /pull/{num} 路由歧义。

修复（基线迁移 0001_initial + 代码侧）：
- 分配前对父仓库行 ``SELECT ... FOR UPDATE`` 串行化同仓库的 max+1；
- 复合唯一约束兜底，兜底路径触发时抛 IntegrityError 而非写入重复编号。

测试方式：两个独立会话（各自持独立连接）并发分配，必须拿到不同编号。
"""
import asyncio

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.issue import Issue
from app.models.pull_request import PullRequest
from app.utils.db_utils import get_next_sequence_number


def _session_factory() -> async_sessionmaker:
    """独立会话工厂：用应用侧 session maker。

    测试中 conftest 已把应用引擎强制为 NullPool（每次取连接新建、
    用完即关），跨事件循环安全；两个会话各自持独立连接，
    才能真实模拟并发事务。注意不能用 async_db.get_bind()——
    AsyncSession.get_bind() 返回的是底层同步 Engine。
    """
    from app.models.async_db import get_async_session_maker

    maker = get_async_session_maker()
    assert maker is not None, "应用 session maker 未初始化"
    return maker


async def test_concurrent_pr_number_allocation(
    async_db: AsyncSession, async_test_repo, async_test_user
):
    """并发创建 PR：两个会话分配到的 pr_number 必须不同"""
    factory = _session_factory()

    async def allocate_and_insert() -> int:
        async with factory() as session:
            number = await get_next_sequence_number(
                session,
                PullRequest,
                "pr_number",
                {"repository_id": async_test_repo.id},
            )
            session.add(
                PullRequest(
                    repository_id=async_test_repo.id,
                    pr_number=number,
                    title="race",
                    source_branch="feature",
                    target_branch="main",
                    author_id=async_test_user.id,
                    status="open",
                )
            )
            await session.commit()
            return number

    first, second = await asyncio.gather(
        allocate_and_insert(), allocate_and_insert()
    )

    assert first != second, f"并发分配拿到重复 PR 编号: {first}"

    # 两行都已落库且编号不重复（唯一约束兜底未被触发）
    from sqlalchemy import select, func

    count = (
        await async_db.execute(
            select(func.count())
            .select_from(PullRequest)
            .filter(PullRequest.repository_id == async_test_repo.id)
        )
    ).scalar()
    assert count == 2


async def test_concurrent_issue_number_allocation(
    async_db: AsyncSession, async_test_repo, async_test_user
):
    """并发创建 Issue：两个会话分配到的 issue_number 必须不同"""
    factory = _session_factory()

    async def allocate_and_insert() -> int:
        async with factory() as session:
            number = await get_next_sequence_number(
                session,
                Issue,
                "issue_number",
                {"repository_id": async_test_repo.id},
            )
            session.add(
                Issue(
                    repository_id=async_test_repo.id,
                    issue_number=number,
                    title="race",
                    author_id=async_test_user.id,
                    status="open",
                    priority="medium",
                )
            )
            await session.commit()
            return number

    first, second = await asyncio.gather(
        allocate_and_insert(), allocate_and_insert()
    )

    assert first != second, f"并发分配拿到重复 Issue 编号: {first}"


async def test_unique_constraint_blocks_duplicate_number(
    async_db: AsyncSession, async_test_repo, async_test_user
):
    """唯一约束兜底：直接插入重复编号必须被数据库拒绝"""
    session = async_db
    number = await get_next_sequence_number(
        session,
        PullRequest,
        "pr_number",
        {"repository_id": async_test_repo.id},
    )

    session.add(
        PullRequest(
            repository_id=async_test_repo.id,
            pr_number=number,
            title="first",
            source_branch="a",
            target_branch="b",
            author_id=async_test_user.id,
            status="open",
        )
    )
    await session.commit()

    session.add(
        PullRequest(
            repository_id=async_test_repo.id,
            pr_number=number,
            title="duplicate",
            source_branch="c",
            target_branch="d",
            author_id=async_test_user.id,
            status="open",
        )
    )
    with pytest.raises(Exception) as exc_info:
        await session.commit()

    assert "uq_pull_requests_repo_number" in str(exc_info.value) or \
        "unique" in str(exc_info.value).lower()

    # 失败事务回滚，不留下半提交状态
    await session.rollback()
