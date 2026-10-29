"""
仓库删除的级联清理测试。

硬删除仓库必须把它名下的 Issue / PR / Release / Webhook / 房间消息 / Agent
作业等一并清掉；否则 NOT NULL 外键（例如 pull_requests.repository_id）会
让删除以 IntegrityError 500 收场。
"""

import pytest
from sqlalchemy import func, select

from app.models.activity import Activity
from app.models.agent import AgentJob, AgentSession, AgentStep
from app.models.chat_message import ChatMessage
from app.models.issue import Issue, IssueComment
from app.models.pull_request import PRComment, PRReview, PullRequest
from app.models.realtime_room import RealtimeRoom, RoomMember
from app.models.release import Release, ReleaseAsset
from app.models.repository import Repository
from app.models.stargazer import Stargazer
from app.models.user import User
from app.models.watcher import Watcher
from app.models.webhook import WebHook, WebHookDelivery
from app.services import repository_service


async def _count(db, model, *conditions) -> int:
    """统计满足条件的行数。"""
    result = await db.execute(
        select(func.count()).select_from(model).where(*conditions)
    )
    return int(result.scalar_one())


@pytest.mark.asyncio
async def test_delete_repository_purges_children(async_db):
    """带 Issue/PR/Release/Webhook/聊天/Agent 作业的仓库可以删除。"""
    user = User(username="cascade-user", email="cascade@example.com", password="x")
    async_db.add(user)
    await async_db.flush()

    repo = await repository_service.create_repository(
        {
            "name": "cascade-repo",
            "path": f"{user.username}/cascade-repo",
            "owner_id": user.id,
            "is_public": False,
        },
        async_db,
    )
    repo_id = repo["id"] if isinstance(repo, dict) else repo.id

    issue = Issue(
        repository_id=repo_id,
        issue_number=1,
        title="级联删除 Issue",
        author_id=user.id,
    )
    async_db.add(issue)
    await async_db.flush()
    async_db.add(IssueComment(issue_id=issue.id, author_id=user.id, content="评论"))

    pr = PullRequest(
        repository_id=repo_id,
        pr_number=1,
        title="级联删除 PR",
        source_branch="feature",
        target_branch="main",
        author_id=user.id,
    )
    async_db.add(pr)
    await async_db.flush()
    async_db.add(PRComment(pull_request_id=pr.id, author_id=user.id, content="评论"))
    async_db.add(
        PRReview(pull_request_id=pr.id, reviewer_id=user.id, status="approved")
    )

    release = Release(
        repository_id=repo_id,
        release_number=1,
        tag_name="v0.0.1",
        name="v0.0.1",
        author_id=user.id,
        commit_hash="0" * 40,
    )
    async_db.add(release)
    await async_db.flush()
    async_db.add(
        ReleaseAsset(
            release_id=release.id, name="a.txt", file_path="/tmp/a.txt", file_size=0
        )
    )

    webhook = WebHook(
        repository_id=repo_id, url="https://example.com/hook", events='["push"]'
    )
    async_db.add(webhook)
    await async_db.flush()
    async_db.add(
        WebHookDelivery(
            webhook_id=webhook.id, event="push", payload="{}", is_success=True
        )
    )

    room_result = await async_db.execute(
        select(RealtimeRoom).where(RealtimeRoom.repository_id == repo_id)
    )
    room = room_result.scalar_one()
    async_db.add(ChatMessage(room_id=room.id, sender_id=user.id, content="hello"))

    session = AgentSession(user_id=user.id, repository_id=repo_id)
    async_db.add(session)
    await async_db.flush()
    job = AgentJob(
        session_id=session.id,
        repository_id=repo_id,
        user_id=user.id,
        prompt="hi",
    )
    async_db.add(job)
    await async_db.flush()
    async_db.add(AgentStep(job_id=job.id, seq=1, type="user", content="hi"))

    fork = Repository(
        name="cascade-fork",
        path=f"{user.username}/cascade-fork",
        owner_id=user.id,
        forked_from_id=repo_id,
    )
    async_db.add(fork)
    async_db.add(
        Activity(
            repository_id=repo_id,
            actor_id=user.id,
            entity_type="repo",
            entity_id=repo_id,
            action="created",
        )
    )
    async_db.add(Stargazer(repository_id=repo_id, user_id=user.id))
    async_db.add(Watcher(repository_id=repo_id, user_id=user.id))
    await async_db.commit()

    await repository_service.delete_repository(repo_id, async_db)
    await async_db.commit()

    models = [
        PullRequest,
        PRComment,
        PRReview,
        Issue,
        IssueComment,
        Release,
        ReleaseAsset,
        WebHook,
        WebHookDelivery,
        RealtimeRoom,
        RoomMember,
        ChatMessage,
        AgentJob,
        AgentStep,
        AgentSession,
        Activity,
        Stargazer,
        Watcher,
    ]
    leftovers = {}
    for model in models:
        column = model.__table__.c.get("repository_id")
        if column is not None:
            count = await _count(async_db, model, column == repo_id)
        elif model is PRComment:
            count = await _count(async_db, model, model.pull_request_id == pr.id)
        elif model is PRReview:
            count = await _count(async_db, model, model.pull_request_id == pr.id)
        elif model is IssueComment:
            count = await _count(async_db, model, model.issue_id == issue.id)
        elif model is ReleaseAsset:
            count = await _count(async_db, model, model.release_id == release.id)
        elif model is WebHookDelivery:
            count = await _count(async_db, model, model.webhook_id == webhook.id)
        elif model is RoomMember:
            count = await _count(async_db, model, model.room_id == room.id)
        elif model is ChatMessage:
            count = await _count(async_db, model, model.room_id == room.id)
        elif model is AgentStep:
            count = await _count(async_db, model, model.job_id == job.id)
        else:
            count = 0
        if count:
            leftovers[model.__tablename__] = count

    assert not leftovers, f"删除仓库后仍有残留行: {leftovers}"

    # Fork 是独立仓库：删除源仓库只解除来源引用，不连带删除 Fork
    await async_db.refresh(fork)
    assert fork.forked_from_id is None
