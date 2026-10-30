"""聊天 → Agent 桥接测试：@bot 唤醒 / 空任务提示 / 失败隔离 / 终态回帖。

设计要点（对话进团队消息流，panel 只承担流程）：
- 普通消息含 @kustos-agent → 创建作业并关联来源房间（source_room_id）
- 只 @ 不带任务 → bot 回 usage 提示
- Agent 未启用等业务拒绝 → 消息照常发送 + bot 回提示（业务异常继承 BaseException，不得打崩消息）
- 回帖以 bot 身份进频道；panel/API 发起（无房间）不回帖
- 启用 Agent → bot 身份即刻存在（不再等首次写工具）
"""
import pytest
from sqlalchemy import select, text

from app.models.agent import AgentJob
from app.models.chat_message import ChatMessage
from app.models.realtime_room import RoomMember, RealtimeRoom
from app.models.user import User
from app.services.realtime.chat_service import ChatService
from app.services.realtime.room_service import RoomService


@pytest.fixture(autouse=True)
def _no_inline_queue(monkeypatch):
    """入队空转：避免 @唤醒作业的 inline 后台任务与 teardown 清理竞态。"""

    class _NoopQueue:
        async def enqueue(self, job_id, provider=None):  # noqa: ARG002
            return None

    import app.services.agent.queue as queue_mod

    async def _fake_get_queue():
        return _NoopQueue()

    monkeypatch.setattr(queue_mod, "get_job_queue", _fake_get_queue)


@pytest.fixture(autouse=True)
def _bridge_provider(monkeypatch):
    """桥接创建作业前有 provider 预检（无 key 不落失败作业行、不进队列）。

    测试环境无真实 key，注入占位 provider 满足预检；本文件的作业队列已 no-op，
    provider 不会被真实调用（真调用会直接 AssertionError 暴露误用）。
    """
    from app.services.agent import providers as providers_mod

    class _PlaceholderProvider:
        name = "placeholder"
        model = "placeholder"

        async def complete(self, messages, tools, *, on_delta=None):  # noqa: ARG001
            raise AssertionError("桥接测试不应真实调用 provider")

    monkeypatch.setattr(
        providers_mod, "_provider_override", _PlaceholderProvider(), raising=False
    )


async def _bot_user(db) -> User:
    return (
        await db.execute(select(User).where(User.username == "kustos-agent"))
    ).scalar_one_or_none()


class TestMentionBridge:
    @pytest.mark.asyncio
    async def test_mention_creates_job_linked_to_room(
        self, async_db, async_test_user, async_test_repo, agent_enabled
    ):
        room = await RoomService.create_room(
            async_db, async_test_repo.id, "general", async_test_user.id
        )
        msg = await ChatService.send_message(
            async_db, room.id, async_test_user.id, "@kustos-agent 帮我看看搜索逻辑"
        )
        # 用户消息原样入流
        assert msg["content"].startswith("@kustos-agent")

        jobs = (
            (
                await async_db.execute(
                    select(AgentJob).where(
                        AgentJob.repository_id == async_test_repo.id
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(jobs) == 1
        job = jobs[0]
        assert job.source_room_id == room.id          # 终态回帖的关联依据
        assert job.prompt == "帮我看看搜索逻辑"        # mention 已剥离
        assert job.user_id == async_test_user.id

    @pytest.mark.asyncio
    async def test_bare_mention_gets_usage_hint(
        self, async_db, async_test_user, async_test_repo, agent_enabled
    ):
        room = await RoomService.create_room(
            async_db, async_test_repo.id, "general", async_test_user.id
        )
        await ChatService.send_message(
            async_db, room.id, async_test_user.id, "@kustos-agent   "
        )
        # 未创建作业
        jobs = (
            await async_db.execute(
                select(AgentJob).where(AgentJob.repository_id == async_test_repo.id)
            )
        ).scalars().all()
        assert len(jobs) == 0
        # bot 回了 usage 提示
        bot = await _bot_user(async_db)
        assert bot is not None
        hint = (
            await async_db.execute(
                select(ChatMessage).where(
                    ChatMessage.room_id == room.id,
                    ChatMessage.sender_id == bot.id,
                )
            )
        ).scalar_one()
        assert "任务描述" in hint.content

    @pytest.mark.asyncio
    async def test_plain_message_creates_no_job(
        self, async_db, async_test_user, async_test_repo, agent_enabled
    ):
        room = await RoomService.create_room(
            async_db, async_test_repo.id, "general", async_test_user.id
        )
        await ChatService.send_message(
            async_db, room.id, async_test_user.id, "这是一条普通团队消息"
        )
        jobs = (
            await async_db.execute(
                select(AgentJob).where(AgentJob.repository_id == async_test_repo.id)
            )
        ).scalars().all()
        assert len(jobs) == 0

    @pytest.mark.asyncio
    async def test_disabled_agent_does_not_break_message(
        self, async_db, async_test_user, async_test_repo
    ):
        """kill switch 关闭（不挂 agent_enabled）：消息照常发送 + bot 回拒绝提示。

        关键回归：业务异常（AuthorizationException 等）继承 BaseException，
        桥接若按 Exception 捕获会让消息发送直接崩。
        """
        room = await RoomService.create_room(
            async_db, async_test_repo.id, "general", async_test_user.id
        )
        msg = await ChatService.send_message(  # 不应抛异常
            async_db, room.id, async_test_user.id, "@kustos-agent 帮我干活"
        )
        assert msg["content"].startswith("@kustos-agent")

        jobs = (
            await async_db.execute(
                select(AgentJob).where(AgentJob.repository_id == async_test_repo.id)
            )
        ).scalars().all()
        assert len(jobs) == 0

        bot = await _bot_user(async_db)
        assert bot is not None
        notice = (
            await async_db.execute(
                select(ChatMessage)
                .where(
                    ChatMessage.room_id == room.id,
                    ChatMessage.sender_id == bot.id,
                )
                .order_by(ChatMessage.created_at.desc())
            )
        ).scalars().first()
        assert "无法创建 Agent 作业" in notice.content


class TestRoomReply:
    @pytest.mark.asyncio
    async def test_reply_posts_as_bot_and_joins_room(
        self, async_db, async_test_user, async_test_repo
    ):
        from app.services.agent.agent_service import AgentService

        room = await RoomService.create_room(
            async_db, async_test_repo.id, "general", async_test_user.id
        )
        # 回帖走独立短会话：先提交房间，保证跨会话可见（FK 约束）
        await async_db.commit()
        await AgentService()._post_room_reply(room.id, "✅ 测试回帖内容")

        bot = await _bot_user(async_db)
        assert bot is not None
        reply = (
            await async_db.execute(
                select(ChatMessage).where(
                    ChatMessage.room_id == room.id,
                    ChatMessage.sender_id == bot.id,
                )
            )
        ).scalar_one()
        assert reply.content == "✅ 测试回帖内容"
        # bot 已成为房间成员（成员列表可见）
        member = (
            await async_db.execute(
                select(RoomMember).where(
                    RoomMember.room_id == room.id,
                    RoomMember.user_id == bot.id,
                )
            )
        ).scalar_one_or_none()
        assert member is not None

    @pytest.mark.asyncio
    async def test_no_room_id_is_noop(self, async_db):
        """panel/API 发起的作业（source_room_id=None）不产生任何聊天消息"""
        from app.services.agent.agent_service import AgentService

        before = (
            await async_db.execute(select(ChatMessage.id))
        ).scalars().all()
        await AgentService()._post_room_reply(None, "不该出现")
        after = (
            await async_db.execute(select(ChatMessage.id))
        ).scalars().all()
        assert before == after


class TestEagerBotIdentity:
    def test_enabling_agent_creates_bot_user(self, test_client, admin_headers, db):
        """启用 Agent 即创建 bot 身份（不再等首次写工具的懒创建）"""
        from app.services.agent.agent_service import AGENT_BOT_USERNAME

        assert _bot_exists(db, AGENT_BOT_USERNAME) is False

        try:
            version = (
                test_client.get("/api/app/agent/config", headers=admin_headers)
                .json()["meta"]["version"]
            )
            resp = test_client.put(
                "/api/app/agent/config",
                json={"values": {"enabled": True}, "version": version},
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            assert _bot_exists(db, AGENT_BOT_USERNAME) is True
        finally:
            # 行级清理不触发 config reload：手动复位，避免 enabled=True
            # 泄漏到同进程的后续测试（它们会因建房入驻 bot 而改变成员计数）
            from app.core.config import get_config

            setattr(get_config().agent, "enabled", False)

    def test_enabling_agent_backfills_repo_and_room_members(
        self, test_client, admin_headers, db, admin_user
    ):
        """启用即回填存量：bot 入驻所有仓库及其频道（成为两边的常驻成员）"""
        from app.models.repository import Repository
        from app.models.repository_member import RepositoryMember
        from app.services.agent.agent_service import AGENT_BOT_USERNAME

        repo = Repository(
            name="backfill-repo",
            path=f"{admin_user.username}/backfill-repo",
            owner_id=admin_user.id,
            is_public=True,
            default_branch="main",
        )
        db.add(repo)
        db.commit()
        db.refresh(repo)
        room = RealtimeRoom(
            repository_id=repo.id,
            name="backfill-repo",
            is_active=True,
            room_type="repository",
        )
        db.add(room)
        db.commit()

        try:
            version = (
                test_client.get("/api/app/agent/config", headers=admin_headers)
                .json()["meta"]["version"]
            )
            resp = test_client.put(
                "/api/app/agent/config",
                json={"values": {"enabled": True}, "version": version},
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text

            bot = (
                db.execute(select(User).where(User.username == AGENT_BOT_USERNAME))
            ).scalar_one()
            in_room = (
                db.execute(
                    select(RoomMember).where(
                        RoomMember.room_id == room.id, RoomMember.user_id == bot.id
                    )
                )
            ).scalar_one_or_none()
            in_repo = (
                db.execute(
                    select(RepositoryMember).where(
                        RepositoryMember.repository_id == repo.id,
                        RepositoryMember.user_id == bot.id,
                    )
                )
            ).scalar_one_or_none()
            assert in_room is not None and in_repo is not None
        finally:
            from app.core.config import get_config

            setattr(get_config().agent, "enabled", False)

    @pytest.mark.asyncio
    async def test_create_room_seeds_bot_member_when_enabled(
        self, async_db, async_test_repo, async_test_user, agent_enabled
    ):
        """Agent 启用期间建房 → bot 预置为频道成员，成员接口如实标记 is_bot"""
        room = await RoomService.create_room(
            async_db, async_test_repo.id, "general", async_test_user.id
        )
        members = await RoomService.get_members(async_db, room.id)
        bots = [m for m in members if m.get("is_bot")]
        assert len(bots) == 1
        assert bots[0]["username"] == "kustos-agent"
        # 普通成员不受影响
        humans = [m for m in members if not m.get("is_bot")]
        assert [m["username"] for m in humans] == ["async_testuser"]

    @pytest.mark.asyncio
    async def test_create_room_skips_bot_when_disabled(
        self, async_db, async_test_repo, async_test_user
    ):
        """kill switch 关闭：建房不入驻 bot（禁用状态不污染成员列表）"""
        room = await RoomService.create_room(
            async_db, async_test_repo.id, "general", async_test_user.id
        )
        members = await RoomService.get_members(async_db, room.id)
        assert len(members) == 1
        assert all(not m.get("is_bot") for m in members)

    @pytest.mark.asyncio
    async def test_lazy_seed_bot_for_pre_existing_room(
        self, async_db, async_test_repo, async_test_user
    ):
        """存量房间：启用前创建 → 启用后打开频道懒补 bot（无需后台重新保存）。

        env 直启部署不触发 PUT 回填钩子；频道详情端点的懒补种是唯一覆盖路径。
        """
        from app.core.config import get_config

        room = await RoomService.create_room(
            async_db, async_test_repo.id, "general", async_test_user.id
        )
        members = await RoomService.get_members(async_db, room.id)
        assert all(not m.get("is_bot") for m in members)

        # 模拟 env 直启（不走后台 PUT）
        setattr(get_config().agent, "enabled", True)
        try:
            await RoomService.ensure_bot_member(async_db, room.id)
            members = await RoomService.get_members(async_db, room.id)
            bots = [m for m in members if m.get("is_bot")]
            assert len(bots) == 1 and bots[0]["username"] == "kustos-agent"
            # 幂等：再补一次不产生重复成员
            await RoomService.ensure_bot_member(async_db, room.id)
            members = await RoomService.get_members(async_db, room.id)
            assert len([m for m in members if m.get("is_bot")]) == 1
        finally:
            setattr(get_config().agent, "enabled", False)


def _bot_exists(db, username: str) -> bool:
    """同步会话直查（conftest db fixture）"""
    row = db.execute(
        text("SELECT 1 FROM users WHERE username = :u"), {"u": username}
    ).scalar_one_or_none()
    return row is not None
