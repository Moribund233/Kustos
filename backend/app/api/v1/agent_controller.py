"""内置 Agent 控制器（审批/开关/SSRF 防护）

端点（仓库级）：
- ``POST   /{repo_id}/agent/jobs``            创建并投递作业
- ``GET    /{repo_id}/agent/jobs``            作业列表
- ``GET    /{repo_id}/agent/jobs/{job_id}``   作业详情
- ``GET    /{repo_id}/agent/jobs/{job_id}/steps`` 步骤（增量拉取，after_seq）
- ``POST   /{repo_id}/agent/jobs/{job_id}/cancel``    取消
- ``POST   /{repo_id}/agent/jobs/{job_id}/approve``   批准待确认的写工具调用
- ``POST   /{repo_id}/agent/jobs/{job_id}/reject``    拒绝待确认的写工具调用

安全：请求体可携带 ``api_key``（内存使用，不落库）；响应与持久化字段均不含密钥。
请求级 ``base_url`` 受服务端白名单约束（防 SSRF，见 ``utils/url_guard.py``）。
"""
from __future__ import annotations

import json
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.prefixes import get_route_prefix
from app.models.async_db import get_async_db
from app.models.user import User
from app.services.agent.runtime import APPROVAL_APPROVED, APPROVAL_REJECTED
from app.services.agent_service import AgentService
from app.core.permissions import require_repo_read
from app.core.constants import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE
from app.core.config import get_config_value

router = APIRouter(
    prefix=get_route_prefix("repositories"), tags=["agent"],
    dependencies=[Depends(require_repo_read())],
)


class CreateJobRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="用户问题/任务（长度上限读 agent.max_prompt_chars）")
    session_id: Optional[uuid.UUID] = Field(None, description="复用已有会话")
    api_key: Optional[str] = Field(None, description="LLM API key（仅内存使用，不落库）")
    base_url: Optional[str] = Field(
        None, description="OpenAI 兼容 base_url（可选覆盖；须在服务端白名单内）"
    )
    model: Optional[str] = Field(None, description="模型名（可选覆盖）")

    @field_validator("prompt")
    @classmethod
    def _check_prompt_length(cls, v: str) -> str:
        """prompt 上限读 ``agent.max_prompt_chars``。

        请求期读取：与 service 侧 ``prompt[:cfg.max_prompt_chars]`` 同键同值，
        后台改配置后两端即时一致（静态 ``max_length`` 会拖到重启才收敛）。
        """
        limit = int(get_config_value("agent", "max_prompt_chars", 8000))
        if len(v) > limit:
            raise ValueError(f"prompt 超过长度上限（{limit} 字符）")
        return v


class ApprovalRequest(BaseModel):
    reason: Optional[str] = Field(
        None, max_length=2000, description="批准/拒绝的附言（拒绝时回灌给模型）"
    )



def _iso(dt) -> Optional[str]:
    return dt.isoformat() if dt else None


def _loads(raw: Optional[str]):
    """宽松解析 JSON 列（脏数据不使整个响应 500）"""
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def _job_dict(job) -> dict:
    return {
        "id": str(job.id),
        "session_id": str(job.session_id),
        "repository_id": str(job.repository_id),
        "status": job.status,
        "prompt": job.prompt,
        "result": job.result,
        "error": job.error,
        "provider": job.provider,
        "model": job.model,
        "step_count": job.step_count,
        "tokens_used": job.tokens_used,
        # usage 拆分（成本审计；旧作业行为 0）
        "prompt_tokens": job.prompt_tokens or 0,
        "completion_tokens": job.completion_tokens or 0,
        "cached_tokens": job.cached_tokens or 0,
        # 待批写工具调用（仅 awaiting_approval 时非空），供前端渲染确认卡片
        "pending_approval": _loads(job.pending_approval),
        "started_at": _iso(job.started_at),
        "finished_at": _iso(job.finished_at),
        "created_at": _iso(job.created_at),
    }



def _step_dict(step) -> dict:
    return {
        "seq": step.seq,
        "type": step.type,
        "name": step.name,
        "content": step.content,
        "data": step.data,
        "created_at": _iso(step.created_at),
    }


@router.post("/{repo_id}/agent/jobs")
async def create_agent_job(
    repo_id: uuid.UUID,
    body: CreateJobRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    job = await AgentService().create_job(
        db,
        current_user,
        repo_id,
        body.prompt,
        session_id=body.session_id,
        api_key=body.api_key,
        base_url=body.base_url,
        model=body.model,
    )
    return _job_dict(job)


@router.get("/{repo_id}/agent/jobs")
async def list_agent_jobs(
    repo_id: uuid.UUID,
    limit: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    jobs = await AgentService().list_jobs(db, current_user, repo_id, limit=limit)
    return {"jobs": [_job_dict(j) for j in jobs]}


@router.get("/{repo_id}/agent/jobs/{job_id}")
async def get_agent_job(
    repo_id: uuid.UUID,
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    job = await AgentService().get_job(db, current_user, job_id)
    return _job_dict(job)


@router.get("/{repo_id}/agent/jobs/{job_id}/steps")
async def get_agent_job_steps(
    repo_id: uuid.UUID,
    job_id: uuid.UUID,
    after_seq: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    steps = await AgentService().get_steps(db, current_user, job_id, after_seq=after_seq)
    return {"steps": [_step_dict(s) for s in steps]}


@router.post("/{repo_id}/agent/jobs/{job_id}/cancel")
async def cancel_agent_job(
    repo_id: uuid.UUID,
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    job = await AgentService().cancel_job(db, current_user, job_id)
    return _job_dict(job)


@router.post("/{repo_id}/agent/jobs/{job_id}/approve")
async def approve_agent_tool_call(
    repo_id: uuid.UUID,
    job_id: uuid.UUID,
    body: ApprovalRequest = ApprovalRequest(),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """批准作业挂起的写工具调用，作业重新入队继续执行。"""
    job = await AgentService().resolve_approval(
        db, current_user, job_id, APPROVAL_APPROVED, body.reason
    )
    return _job_dict(job)


@router.post("/{repo_id}/agent/jobs/{job_id}/reject")
async def reject_agent_tool_call(
    repo_id: uuid.UUID,
    job_id: uuid.UUID,
    body: ApprovalRequest = ApprovalRequest(),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """拒绝作业挂起的写工具调用；该工具不执行，原因回灌给模型。"""
    job = await AgentService().resolve_approval(
        db, current_user, job_id, APPROVAL_REJECTED, body.reason
    )
    return _job_dict(job)