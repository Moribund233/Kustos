"""PR 评审请求服务

与 ``create_pr_review`` 的分工：
- 这里只管理「请谁看」（requested reviewer），不写评审结论
- 结论仍落在 ``pr_reviews``，展示时把两者按 reviewer 合并，state 由评审推导

这样同一个人可以先被请求、后提交结论，也可以不请自来直接评审；两种入口不会
互相覆盖状态。
"""
import logging
import uuid
from typing import List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.core.exception import NotFoundException, ValidationException
from app.core.permissions import ensure_author_or_admin
from app.models import PRReview, PRReviewRequest, Repository, RepositoryMember, User
from app.services.collaboration.pr_activity_service import record_activity as record_pr_activity
from app.utils.db_utils import get_pull_request_or_404
from app.utils.response_builder import build_pr_review_request_response

logger = logging.getLogger(__name__)


async def _assert_repo_participant(
    db: AsyncSession, repository_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    """评审人必须是仓库 owner 或在册成员。

    否则任何人都能把外部账号拉进 PR 的评审列表，既是噪音也是信息泄漏。
    """
    repo = await db.get(Repository, repository_id)
    if repo is not None and repo.owner_id == user_id:
        return

    result = await db.execute(
        select(RepositoryMember.id).filter(
            RepositoryMember.repository_id == repository_id,
            RepositoryMember.user_id == user_id,
            RepositoryMember.is_active == True,  # noqa: E712
        )
    )
    if result.first() is None:
        raise ValidationException(
            detail="Requested reviewer is not a member of this repository",
            error_code="pr_reviewer_not_member",
        )


async def _request_rows(
    db: AsyncSession, pr_id: uuid.UUID
) -> List[PRReviewRequest]:
    result = await db.execute(
        select(PRReviewRequest)
        .options(
            joinedload(PRReviewRequest.reviewer),
            joinedload(PRReviewRequest.requester),
        )
        .filter(PRReviewRequest.pull_request_id == pr_id)
        .order_by(PRReviewRequest.created_at, PRReviewRequest.id)
    )
    return list(result.scalars().unique())


async def _review_map(db: AsyncSession, pr_id: uuid.UUID) -> dict:
    result = await db.execute(
        select(PRReview).filter(PRReview.pull_request_id == pr_id)
    )
    return {review.reviewer_id: review for review in result.scalars()}


async def list_review_requests(
    db: AsyncSession, repository_id: uuid.UUID, pr_number: int
) -> List[dict]:
    """返回该 PR 的评审请求（含已提交结论的状态）。"""
    pr = await get_pull_request_or_404(db, repository_id, pr_number)
    requests = await _request_rows(db, pr.id)
    reviews = await _review_map(db, pr.id)
    return [
        build_pr_review_request_response(req, reviews.get(req.reviewer_id))
        for req in requests
    ]


async def request_reviewers(
    db: AsyncSession,
    repository_id: uuid.UUID,
    pr_number: int,
    actor_id: uuid.UUID,
    user_ids: Optional[Sequence[uuid.UUID]] = None,
    usernames: Optional[Sequence[str]] = None,
) -> List[dict]:
    """请求一个或多个用户评审。重复请求是幂等的，不会重置已有结论。"""
    pr = await get_pull_request_or_404(db, repository_id, pr_number)
    await ensure_author_or_admin(db, pr.author_id, actor_id, repository_id, "request reviewers")

    wanted_ids = [uid for uid in (user_ids or []) if uid]
    wanted_names = [name.strip() for name in (usernames or []) if name and name.strip()]
    if not wanted_ids and not wanted_names:
        raise ValidationException(
            detail="Provide at least one reviewer",
            error_code="pr_reviewer_required",
        )

    result = await db.execute(
        select(User).filter(
            (User.id.in_(wanted_ids)) | (User.username.in_(wanted_names))
        )
    )
    users = list(result.scalars().unique())
    found_ids = {user.id for user in users}
    missing = [str(uid) for uid in wanted_ids if uid not in found_ids]
    missing += [name for name in wanted_names if name not in {u.username for u in users}]
    if missing:
        raise NotFoundException(
            detail=f"Unknown reviewer(s): {', '.join(missing)}",
            error_code="pr_reviewer_not_found",
        )

    existing = await db.execute(
        select(PRReviewRequest.reviewer_id).filter(
            PRReviewRequest.pull_request_id == pr.id
        )
    )
    already = set(existing.scalars())

    candidates = [
        user for user in users if user.id != pr.author_id and user.id not in already
    ]
    # 先全部校验再落库：中途 400 不该留下半批请求
    for user in candidates:
        await _assert_repo_participant(db, repository_id, user.id)

    added = []
    for user in candidates:
        db.add(
            PRReviewRequest(
                pull_request_id=pr.id,
                reviewer_id=user.id,
                requested_by=actor_id,
            )
        )
        added.append(user)

    if added:
        await db.flush()
        for user in added:
            await record_pr_activity(
                pr_id=pr.id,
                actor_id=actor_id,
                action="review_requested",
                details=user.username,
                db=db,
            )
            try:
                # 延迟导入：notification_service 反向依赖 api.ws 处理器，
                # 在模块顶层引入会把 api 层拖进服务层的导入链
                from app.services.messaging.notification_service import create_notification

                await create_notification(
                    db=db,
                    user_id=user.id,
                    type="review_requested",
                    title=f"Review requested on #{pr.pr_number}",
                    message=f"{pr.title} is waiting for your review.",
                    repository_id=repository_id,
                    target_type="pull_request",
                    target_id=pr.id,
                )
            except Exception as exc:  # 通知失败不能回滚评审请求
                logger.warning("Failed to notify reviewer %s: %s", user.username, exc)

    return await list_review_requests(db, repository_id, pr_number)


async def remove_reviewer(
    db: AsyncSession,
    repository_id: uuid.UUID,
    pr_number: int,
    actor_id: uuid.UUID,
    reviewer_id: uuid.UUID,
) -> List[dict]:
    """撤回某人的评审请求；已提交的评审记录不受影响。"""
    pr = await get_pull_request_or_404(db, repository_id, pr_number)
    await ensure_author_or_admin(db, pr.author_id, actor_id, repository_id, "remove reviewers")

    result = await db.execute(
        select(PRReviewRequest).filter(
            PRReviewRequest.pull_request_id == pr.id,
            PRReviewRequest.reviewer_id == reviewer_id,
        )
    )
    request = result.scalar_one_or_none()
    if request is None:
        raise NotFoundException(
            detail="This user was not requested to review",
            error_code="pr_review_request_not_found",
        )

    await db.delete(request)
    await db.flush()
    await record_pr_activity(
        pr_id=pr.id,
        actor_id=actor_id,
        action="review_request_removed",
        details=str(reviewer_id),
        db=db,
    )
    return await list_review_requests(db, repository_id, pr_number)
