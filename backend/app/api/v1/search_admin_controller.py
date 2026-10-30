"""搜索/embedding 管理面控制器（``/api/app/search/*``）。

embedding 配置与 LLM 配置**分端点、分白名单、分密钥**（可选索引增强，
默认折叠）——密钥密文落库、永不回显、写入仅限管理员。

权限与审计口径同 agent 面：读 ``check_app_permission``，写
``check_app_danger_permission``；密钥字段额外要求 ``is_admin``。
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.guards import check_app_danger_permission, check_app_permission
from app.models.async_db import get_async_db
from app.models.user import User
from app.services.search.search_admin_service import get_search_admin_service

router = APIRouter(tags=["app-management"])


class SearchConfigPutRequest(BaseModel):
    """配置保存请求（``{values, version}`` + 密钥字段，与 agent PUT 同构）"""

    values: Dict[str, Any] = Field(
        ..., description="可写白名单键的部分更新（白名单见 GET meta.editable_keys）"
    )
    version: int = Field(
        ..., ge=0, description="乐观锁版本（GET meta.version，不符 → 409）"
    )
    embedding_api_key: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=4096,
        description="Embedding API key 明文（仅本次请求在内存使用，密文落库；缺省不修改）",
    )
    clear_embedding_api_key: bool = Field(
        default=False,
        description="清除 DB 中保存的 Embedding API key（与 embedding_api_key 互斥）",
    )


@router.get("/api/app/search/config")
async def get_search_config_endpoint(
    permission: tuple = Depends(check_app_permission),
):
    """
    读取搜索/embedding 配置（含 meta）

    Returns:
        dict: ``{config: {...}, meta: {editable_keys, hot_keys, restart_keys,
        source, version, writable, key_state}}``——配置模型不含 key 字段，
        响应结构上无密钥可回显。
    """
    return get_search_admin_service().get_config_view()


@router.get("/api/app/search/index-overview")
async def get_search_index_overview_endpoint(
    db: AsyncSession = Depends(get_async_db),
    permission: tuple = Depends(check_app_permission),
):
    """
    全实例索引健康度（admin 索引页；只读派生数据）

    Returns:
        dict: ``{repos: [{id, name, path, head_commit, indexed_commit, in_sync,
        chunks, refs, embeddings, last_indexed_at}], totals, semantic_enabled,
        current_generation}``
    """
    return await get_search_admin_service().index_overview(db)


@router.put("/api/app/search/config")
async def put_search_config_endpoint(
    payload: SearchConfigPutRequest,
    permission: tuple = Depends(check_app_danger_permission),
    current_user: User = Depends(get_current_user),
):
    """
    保存搜索/embedding 配置（写入 ``app_config[search]``；密钥密文落库）

    Args:
        payload: ``{values, version, embedding_api_key?, clear_embedding_api_key?}``
            ——version 不符 → 409 ``search_config_version_conflict``；键/值非法
            → 422 ``search_config_invalid``；密钥写入仅限管理员
            （``app_admin_required``）
        current_user: 当前用户（落审计）

    Returns:
        dict: ``{version, applied, env_overridden, key_state}``
    """
    return get_search_admin_service().update_config(
        values=payload.values,
        version=payload.version,
        updated_by=current_user.id,
        embedding_api_key=payload.embedding_api_key,
        clear_embedding_api_key=payload.clear_embedding_api_key,
        is_admin=bool(current_user.is_admin),
    )
