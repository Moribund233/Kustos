"""Agent 管理面控制器（``/api/app/agent/*``：配置读写 + 连通性探测）。

- ``GET/PUT /api/app/agent/config``   配置读写（GET 含 source/version meta；
  PUT 走白名单校验 + 行版本乐观锁）
- ``GET  /api/app/agent/providers``   常量供应商目录
- ``GET  /api/app/agent/models``      服务端代理拉取上游 ``/models``（env key）
- ``POST /api/app/agent/test-connection`` 配置级连接探测
- ``GET  /api/app/agent/key-status``  key「有没有」（永不回 key 值）

权限：读 ``check_app_permission``，写/探测 ``check_app_danger_permission``
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.v1.app_controller import (
    check_app_danger_permission,
    check_app_permission,
)
from app.models.async_db import get_async_db
from app.models.user import User
from app.services.agent.agent_admin_service import get_agent_admin_service

router = APIRouter(tags=["app-management"])


class TestConnectionRequest(BaseModel):
    """连接探测请求（``{base_url, model?}``，provider 为附加便利字段）"""

    base_url: Optional[str] = Field(
        default=None, description="覆盖 base_url；缺省取 provider 目录值/当前配置"
    )
    provider: Optional[str] = Field(default=None, description="目录 provider id（可选）")
    model: Optional[str] = Field(default=None, description="探活模型；缺省取 agent.model")


class AgentConfigPutRequest(BaseModel):
    """配置保存请求（``{values, version}`` + 密钥字段）"""

    values: Dict[str, Any] = Field(
        ..., description="可写白名单键的部分更新（白名单见 GET meta.editable_keys）"
    )
    version: int = Field(
        ..., ge=0, description="乐观锁版本（GET meta.version，不符 → 409）"
    )
    api_key: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=4096,
        description="LLM API key 明文（仅本次请求在内存使用，密文落库；缺省不修改）",
    )
    clear_api_key: bool = Field(
        default=False, description="清除 DB 中保存的 API key（与 api_key 互斥）"
    )


@router.get("/api/app/agent/config")
async def get_agent_config_endpoint(
    permission: tuple = Depends(check_app_permission),
):
    """
    读取 Agent 配置（含 meta）

    Returns:
        dict: ``{config: {...}, meta: {editable_keys, hot_keys, restart_keys,
        source, version, writable}}``——``version`` 为 agent 节行版本（PUT 乐观锁凭据）；
        key 只存环境变量名，响应无密钥。
    """
    return get_agent_admin_service().get_config_view()


@router.put("/api/app/agent/config")
async def put_agent_config_endpoint(
    payload: AgentConfigPutRequest,
    permission: tuple = Depends(check_app_danger_permission),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    """
    保存 Agent 配置（写入 ``app_config[agent]``；本进程立即生效，其余进程 ≤5s 收敛）

    Args:
        payload: ``{values, version, api_key?, clear_api_key?}``——version 与
            库内行版本不符 → 409 ``agent_config_version_conflict``；键不在白名单
            或值超约束 → 422 ``agent_config_invalid``；密钥写入仅限管理员
            （``app_admin_required``），密文与配置同事务落库、响应零回显
        current_user: 当前用户（落 ``app_config.updated_by``/密钥审计）

    Returns:
        dict: ``{version, applied: {键: "immediate"}, env_overridden: [...],
        key_state: {configured, source}}``
    """
    result = get_agent_admin_service().update_config(
        values=payload.values,
        version=payload.version,
        updated_by=current_user.id,
        api_key=payload.api_key,
        clear_api_key=payload.clear_api_key,
        is_admin=bool(current_user.is_admin),
    )
    # 启用 Agent 即创建 bot 身份（聊天 @唤醒的目标账号；首次写工具的懒创建保留兜底），
    # 并回填入驻：bot 成为所有仓库及其频道的成员（存量环境一次性补齐）
    if payload.values.get("enabled") is True:
        from app.services.agent.agent_service import AgentService

        try:
            bot = await AgentService().ensure_bot_user(db)
            await AgentService().add_bot_to_repositories(db, bot.id)
            from app.services.realtime.room_service import RoomService

            await RoomService.add_bot_to_repository_rooms(db, bot.id)
            await db.commit()
        except Exception:  # noqa: BLE001 — 身份/入驻失败不回滚配置保存
            import logging

            logging.getLogger(__name__).exception("启用 Agent 时 bot 入驻失败")
    return result


@router.get("/api/app/agent/providers")
async def list_agent_providers_endpoint(
    permission: tuple = Depends(check_app_permission),
):
    """
    供应商目录（只读常量）

    Returns:
        dict: ``{providers: [{id, label, base_url, models, key_env, ...}], allow_custom}``
    """
    return get_agent_admin_service().list_providers()


@router.get("/api/app/agent/models")
async def get_agent_models_endpoint(
    provider: Optional[str] = Query(
        None, description="目录 provider id（未知 id → agent_provider_not_found）"
    ),
    base_url: Optional[str] = Query(
        None, description="覆盖 base_url（配置级校验，优先于 provider 目录值）"
    ),
    permission: tuple = Depends(check_app_permission),
):
    """
    模型列表（服务端用 env key 代理 ``GET {base_url}/models``，5s 超时）

    不接受请求体 key（不进日志、不进 URL）。失败：``agent_key_missing``(400) /
    ``agent_base_url_forbidden``(400) / ``agent_models_unavailable``(502，
    目录有静态兜底时改回 ``source="static"``)。

    Returns:
        dict: ``{models: [{id}], source: "remote"|"static", base_url, provider, ...}``
    """
    return await get_agent_admin_service().get_models(provider=provider, base_url=base_url)


@router.post("/api/app/agent/test-connection")
async def test_agent_connection_endpoint(
    payload: TestConnectionRequest = Body(...),
    permission: tuple = Depends(check_app_danger_permission),
):
    """
    连接探测（管理员配置级）

    先 ``GET /models``，端点不支持（404/405）则降级 1-token ``/chat/completions``。
    连通性结果软失败（``200 + ok=false + error_code``，前端内联渲染）；
    仅输入非法（base_url 形态 / 未知 provider）返回 400。

    Returns:
        dict: ``{ok, base_url, model, latency_ms, checked_at, source?, error_code?, error?}``
    """
    return await get_agent_admin_service().test_connection(
        base_url=payload.base_url, provider=payload.provider, model=payload.model
    )


@router.get("/api/app/agent/key-status")
async def get_agent_key_status_endpoint(
    permission: tuple = Depends(check_app_permission),
):
    """
    密钥状态（只回「有没有」；**永不返回 key 值**）

    Returns:
        dict: ``{env_name, configured, injection, providers: [{id, key_env, configured, source_env}]}``
    """
    return get_agent_admin_service().get_key_status()


@router.get("/api/app/agent/usage")
async def get_agent_usage_endpoint(
    days: int = Query(7, ge=1, le=90, description="统计窗口（天，UTC 日界）"),
    db: AsyncSession = Depends(get_async_db),
    permission: tuple = Depends(check_app_permission),
):
    """
    用量聚合（admin 概览图表用；只读，不回显 prompt/result）

    Returns:
        dict: ``{days, since, daily: [{date, jobs, succeeded, failed, tokens,
        avg_duration_s}], totals, tools: [{name, calls}]}``
    """
    return await get_agent_admin_service().get_usage(db, days=days)
