"""PR ↔ Issue 关联服务

职责：
- 显式关联/解除关联（双向，PR 侧与 Issue 侧共用同一张边表）
- 从 PR 标题/描述里的 ``fixes/closes/resolves #N`` 自动建立关联
- PR 合并时按 ``closes_on_merge`` 关闭对应 Issue

关联只允许发生在同一仓库内：跨仓引用既不建边，也不报错（自动推导时），
显式调用则返回 404，避免把另一个仓库的私有编号暴露出来。
"""
import logging
import re

import uuid
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.core.exception import NotFoundException
from app.core.permissions import ensure_author_or_admin
from app.models import Issue, PullRequest, PullRequestIssueLink
from app.services.activity_service import try_record_activity
from app.services.pr_activity_service import record_activity as record_pr_activity
from app.utils.db_utils import get_issue_or_404, get_pull_request_or_404
from app.utils.response_builder import (
    build_issue_pull_request_response,
    build_pr_linked_issue_response,
)

logger = logging.getLogger(__name__)

#: "Fixes #12" / "Closes #7, #8" / "Resolved #3"
_CLOSING_REF_RE = re.compile(
    r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[:\s]*((?:#\d+[\s,]*)+)",
    re.IGNORECASE,
)
_ISSUE_NUM_RE = re.compile(r"#(\d+)")


def extract_closing_references(text: Optional[str]) -> List[int]:
    """从文本里提取 ``Fixes #N`` 形式的 Issue 编号（去重、保持出现顺序）。"""
    if not text:
        return []
    seen: List[int] = []
    for match in _CLOSING_REF_RE.finditer(text):
        for number in _ISSUE_NUM_RE.findall(match.group(1)):
            value = int(number)
            if value not in seen:
                seen.append(value)
    return seen


async def _linked_issue_rows(db: AsyncSession, pr_id: uuid.UUID) -> List[PullRequestIssueLink]:
    """读取某 PR 的关联边（含 issue），按建立时间升序。"""
    result = await db.execute(
        select(PullRequestIssueLink)
        .options(joinedload(PullRequestIssueLink.issue))
        .filter(PullRequestIssueLink.pull_request_id == pr_id)
        .order_by(PullRequestIssueLink.created_at, PullRequestIssueLink.id)
    )
    return list(result.scalars().unique())


async def _linked_pr_rows(db: AsyncSession, issue_id: uuid.UUID) -> List[PullRequestIssueLink]:
    """读取某 Issue 的关联边（含 PR），按建立时间升序。"""
    result = await db.execute(
        select(PullRequestIssueLink)
        .options(joinedload(PullRequestIssueLink.pull_request))
        .filter(PullRequestIssueLink.issue_id == issue_id)
        .order_by(PullRequestIssueLink.created_at, PullRequestIssueLink.id)
    )
    return list(result.scalars().unique())


async def list_linked_issues(
    db: AsyncSession, repository_id: uuid.UUID, pr_number: int
) -> List[dict]:
    """PR 视角：返回关联的 Issue 列表。"""
    pr = await get_pull_request_or_404(db, repository_id, pr_number)
    links = await _linked_issue_rows(db, pr.id)
    return [build_pr_linked_issue_response(link) for link in links]


async def list_linked_pull_requests(
    db: AsyncSession, repository_id: uuid.UUID, issue_number: int
) -> List[dict]:
    """Issue 视角：返回关联的 PR 列表。"""
    issue = await get_issue_or_404(db, repository_id, issue_number)
    links = await _linked_pr_rows(db, issue.id)
    return [build_issue_pull_request_response(link) for link in links]


async def link_issue_to_pr(
    db: AsyncSession,
    repository_id: uuid.UUID,
    pr_number: int,
    actor_id: uuid.UUID,
    issue_number: int,
    closes_on_merge: bool = True,
) -> List[dict]:
    """显式把 Issue 关联到 PR（幂等：重复关联只更新 closes_on_merge）。"""
    pr = await get_pull_request_or_404(db, repository_id, pr_number)
    await ensure_author_or_admin(db, pr.author_id, actor_id, repository_id, "link issues to this pull request")

    issue = await get_issue_or_404(db, repository_id, issue_number)

    result = await db.execute(
        select(PullRequestIssueLink).filter(
            PullRequestIssueLink.pull_request_id == pr.id,
            PullRequestIssueLink.issue_id == issue.id,
        )
    )
    link = result.scalar_one_or_none()
    if link:
        link.closes_on_merge = closes_on_merge
    else:
        db.add(
            PullRequestIssueLink(
                pull_request_id=pr.id,
                issue_id=issue.id,
                created_by=actor_id,
                closes_on_merge=closes_on_merge,
            )
        )
    await db.flush()

    await record_pr_activity(
        pr_id=pr.id,
        actor_id=actor_id,
        action="linked_issue",
        details=f"#{issue.issue_number}",
        db=db,
    )
    return await list_linked_issues(db, repository_id, pr_number)


async def unlink_issue_from_pr(
    db: AsyncSession,
    repository_id: uuid.UUID,
    pr_number: int,
    actor_id: uuid.UUID,
    issue_number: int,
) -> List[dict]:
    """解除 PR 与 Issue 的关联。"""
    pr = await get_pull_request_or_404(db, repository_id, pr_number)
    await ensure_author_or_admin(db, pr.author_id, actor_id, repository_id, "unlink issues from this pull request")

    issue = await get_issue_or_404(db, repository_id, issue_number)
    result = await db.execute(
        select(PullRequestIssueLink).filter(
            PullRequestIssueLink.pull_request_id == pr.id,
            PullRequestIssueLink.issue_id == issue.id,
        )
    )
    link = result.scalar_one_or_none()
    if not link:
        raise NotFoundException(
            detail=f"Issue #{issue_number} is not linked to this pull request",
            error_code="pr_issue_link_not_found",
        )

    await db.delete(link)
    await db.flush()

    await record_pr_activity(
        pr_id=pr.id,
        actor_id=actor_id,
        action="unlinked_issue",
        details=f"#{issue.issue_number}",
        db=db,
    )
    return await list_linked_issues(db, repository_id, pr_number)


async def link_pr_to_issue(
    db: AsyncSession,
    repository_id: uuid.UUID,
    issue_number: int,
    actor_id: uuid.UUID,
    pr_number: int,
    closes_on_merge: bool = True,
) -> List[dict]:
    """Issue 视角的关联入口（语义等同 :func:`link_issue_to_pr`）。"""
    return await link_issue_to_pr(
        db,
        repository_id=repository_id,
        pr_number=pr_number,
        actor_id=actor_id,
        issue_number=issue_number,
        closes_on_merge=closes_on_merge,
    )


async def unlink_pr_from_issue(
    db: AsyncSession,
    repository_id: uuid.UUID,
    issue_number: int,
    actor_id: uuid.UUID,
    pr_number: int,
) -> List[dict]:
    """Issue 视角的解除关联入口。"""
    return await unlink_issue_from_pr(
        db,
        repository_id=repository_id,
        pr_number=pr_number,
        actor_id=actor_id,
        issue_number=issue_number,
    )


async def auto_link_from_description(
    db: AsyncSession, pr: PullRequest, actor_id: uuid.UUID
) -> List[int]:
    """根据 PR 标题/描述里的 ``Fixes #N`` 自动建立关联。

    不覆盖已有边（避免把用户手动改过的 ``closes_on_merge`` 冲掉），指向不存在
    的 Issue 时静默跳过——描述是人写的，不能因为写错编号就让创建 PR 失败。
    """
    numbers = extract_closing_references(f"{pr.title}\n{pr.description or ''}")
    if not numbers:
        return []

    result = await db.execute(
        select(Issue).filter(
            Issue.repository_id == pr.repository_id,
            Issue.issue_number.in_(numbers),
        )
    )
    issues = {issue.issue_number: issue for issue in result.scalars()}

    existing = await db.execute(
        select(PullRequestIssueLink.issue_id).filter(
            PullRequestIssueLink.pull_request_id == pr.id
        )
    )
    already = set(existing.scalars())

    linked: List[int] = []
    for number in numbers:
        issue = issues.get(number)
        if issue is None or issue.id in already:
            continue
        db.add(
            PullRequestIssueLink(
                pull_request_id=pr.id,
                issue_id=issue.id,
                created_by=actor_id,
                closes_on_merge=True,
            )
        )
        linked.append(number)

    if linked:
        await db.flush()
        logger.info("PR #%s auto-linked issues %s", pr.pr_number, linked)
    return linked


async def close_linked_issues(
    db: AsyncSession, pr: PullRequest, actor_id: uuid.UUID
) -> List[int]:
    """合并 PR 后关闭 ``closes_on_merge`` 的关联 Issue，返回被关闭的编号。"""
    links = await _linked_issue_rows(db, pr.id)
    closed = []
    for link in links:
        issue = link.issue
        if issue is None or not link.closes_on_merge or issue.status == "closed":
            continue
        issue.status = "closed"
        issue.closed_by = actor_id
        closed.append(issue)

    if not closed:
        return []

    await db.flush()
    for issue in closed:
        # 活动流按 Issue 维度记一条，Dashboard 才能看到"由 PR 关闭"
        await try_record_activity(
            repository_id=pr.repository_id,
            actor_id=actor_id,
            entity_type="issue",
            entity_id=issue.id,
            action="closed",
            details=f"Closed via #{pr.pr_number}",
            db=db,
        )
    return [issue.issue_number for issue in closed]
