"""通用审计日志服务模块"""
import logging
import uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.activity import Activity
from app.utils.db_utils import paginate
from app.utils.response_builder import build_pagination_response

logger = logging.getLogger(__name__)


async def record_activity(
    repository_id: uuid.UUID, actor_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID,
    action: str, details: str | None = None, db: AsyncSession | None = None,
) -> dict:
    """记录审计日志"""
    if db is None:
        raise ValueError("db session is required")
    activity = Activity(
        repository_id=repository_id, actor_id=actor_id,
        entity_type=entity_type, entity_id=entity_id,
        action=action, details=details,
    )
    db.add(activity)
    await db.flush()
    await db.refresh(activity)
    return {
        "id": activity.id,
        "repository_id": activity.repository_id,
        "actor_id": activity.actor_id,
        "entity_type": activity.entity_type,
        "entity_id": activity.entity_id,
        "action": activity.action,
        "details": activity.details,
        "created_at": activity.created_at.isoformat() if activity.created_at else None,
    }


async def try_record_activity(
    repository_id: uuid.UUID, actor_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID,
    action: str, details: str | None = None, db: AsyncSession | None = None,
) -> None:
    """
    埋点封装：失败仅记日志，绝不影响主业务流程

    供 PR/Issue 等生命周期动作调用，用于填充 Dashboard 活动流。
    """
    try:
        await record_activity(
            repository_id=repository_id, actor_id=actor_id,
            entity_type=entity_type, entity_id=entity_id,
            action=action, details=details, db=db,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("Failed to record activity %s/%s: %s", entity_type, action, e)


async def list_activities(
    repository_id: uuid.UUID | None, db: AsyncSession,
    entity_type: str | None = None, actor_id: uuid.UUID | None = None,
    page: int = 1, limit: int = 20,
    repository_ids: list[uuid.UUID] | None = None,
) -> dict:
    """查询审计日志

    Args:
        repository_id: 限定单个仓库；``None`` 表示跨仓库
        db: 异步数据库会话
        entity_type: 实体类型过滤
        actor_id: 操作者过滤
        page: 页码
        limit: 每页条数
        repository_ids: 跨仓库查询时的可见仓库白名单；与 ``repository_id`` 同时
            为空时返回空集——不提供"不带范围就查全表"的路径

    Returns:
        dict: 分页结果
    """
    stmt = select(Activity)
    if repository_id is not None:
        stmt = stmt.filter(Activity.repository_id == repository_id)
    elif repository_ids:
        stmt = stmt.filter(Activity.repository_id.in_(repository_ids))
    else:
        return build_pagination_response([], 0, page, limit)
    if entity_type:
        stmt = stmt.filter(Activity.entity_type == entity_type)
    if actor_id:
        stmt = stmt.filter(Activity.actor_id == actor_id)
    stmt = stmt.order_by(Activity.created_at.desc())

    activities, total = await paginate(db, stmt, page=page, limit=limit)
    items = [
        {
            "id": a.id, "repository_id": a.repository_id, "actor_id": a.actor_id,
            "entity_type": a.entity_type, "entity_id": a.entity_id,
            "action": a.action, "details": a.details,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in activities
    ]
    return build_pagination_response(items, total, page, limit)
