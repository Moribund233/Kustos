"""协作感知控制器

GET /{repo_id}/collab/active — 返回该仓库当前活跃的协作文档清单。

桌面端用它做两件 Web 做不到的事：文件树上的 live 圆点，以及"进入协作前"
的在线人数预警。两者都发生在用户真正加入会话之前，因此这个端点必须是
**轻量、只读、可降级**的。

数据来自协作网关的实时连接计数（见 ``collab_active_service``），app 只做聚合并
裁决读权限——权限永远由 :mod:`app.core.permissions` 裁定，此处不重复实现。

响应有意区分 ``documents`` 与 ``degraded``：空清单既可能是"确实没人在编辑"，
也可能是"感知能力不可用"。让前端自己猜，会导致用户误以为可以安全地以本地
内容开新会话，而这恰恰是设计文档里最危险的误判。
"""

import uuid
from typing import List

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.guards import require_repo_read
from app.api.prefixes import get_route_prefix
from app.core.permissions import Action, ensure_repo_action
from app.models import User
from app.models.async_db import get_async_db
from app.services.collaboration.collab_active_service import (
    collect_active_documents,
    is_degraded,
)

router = APIRouter(
    prefix=get_route_prefix("repositories"),
    tags=["collab-active"],
    dependencies=[Depends(require_repo_read())],
)


class ActiveDocument(BaseModel):
    """单个活跃文档；不含身份信息（身份从 awareness 取）"""

    docKey: str = Field(..., description="文档标识 repository_id:branch:path")
    connections: int = Field(..., description="该文档当前的活跃连接数（多副本求和）")


class ActiveDocumentsResponse(BaseModel):
    """活跃文档清单；degraded 为真时清单不可信，前端应隐藏 live 提示"""

    documents: List[ActiveDocument] = Field(
        default_factory=list, description="按 docKey 升序的活跃文档"
    )
    degraded: bool = Field(
        ...,
        description="协作感知不可用（网关未配置或不可达）；为真时不得据此判断无人在线",
    )


@router.get("/{repo_id}/collab/active", response_model=ActiveDocumentsResponse)
async def get_active_collab_documents(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    查询仓库当前活跃的协作文档

    需要该仓库的协作读权限（与进入会话同一裁决，避免"看不到会话却能看到谁在编辑"）。

    Returns:
        ``{documents, degraded}``；网关不可达时 documents 为空且 degraded 为真
    """
    await ensure_repo_action(db, current_user.id, repo_id, Action.COLLAB_READ)

    documents = await collect_active_documents(str(repo_id))
    return {"documents": documents, "degraded": is_degraded()}
