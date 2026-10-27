"""server-plane 写工具。

全部为现有 service 的薄适配器，`scope="repo:write"`；运行时在执行前统一校验
调用者具备仓库写角色（owner/admin/developer），不满足则拒绝并回灌模型。
写操作包括：建 Issue / Issue 评论 / PR 评论 / 开 PR / 提交文件。
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional, Tuple

from app.services.agent.tool_registry import SCOPE_WRITE, ToolContext, ToolSpec, register_tool

_P = "string"

_LOADED = False


# --------------------------- 处理器 ---------------------------

async def _create_issue(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.issue_service import create_issue

    title = str(args.get("title") or "").strip()
    if not title:
        return {"error": "title 为空"}
    return await create_issue(
        ctx.db, ctx.repository_id, ctx.user_id,
        title=title, description=args.get("body"), priority=args.get("priority", "medium"),
    )


async def _comment_on_issue(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.issue_service import create_issue_comment

    body = str(args.get("body") or "").strip()
    if not body:
        return {"error": "body 为空"}
    return await create_issue_comment(
        ctx.db, ctx.repository_id, int(args.get("number") or 0), ctx.user_id, body
    )


async def _set_priority(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.issue_service import update_issue

    number = int(args.get("number") or 0)
    priority = str(args.get("priority") or "").strip()
    if number <= 0:
        return {"error": "number 非法"}
    if priority not in ("low", "medium", "high", "critical"):
        return {"error": "priority 非法（low/medium/high/critical）"}
    return await update_issue(
        ctx.db, ctx.repository_id, number, ctx.user_id, priority=priority
    )


async def _apply_label(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from sqlalchemy import select

    from app.models.issue import Label
    from app.services.issue_service import batch_add_labels

    number = int(args.get("number") or 0)
    label = str(args.get("label") or "").strip()
    if number <= 0 or not label:
        return {"error": "number / label 必填"}
    row = (
        await ctx.db.execute(
            select(Label).where(
                Label.repository_id == ctx.repository_id, Label.name == label
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return {"error": f"标签不存在: {label}"}
    return await batch_add_labels(
        ctx.db, ctx.repository_id, ctx.user_id, [number], [row.id]
    )


async def _comment_on_pull_request(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.pull_request_service import create_pr_comment

    body = str(args.get("body") or "").strip()
    if not body:
        return {"error": "body 为空"}
    return await create_pr_comment(
        ctx.db, ctx.repository_id, int(args.get("number") or 0), ctx.user_id, body
    )


async def _create_pull_request(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.pull_request_service import create_pull_request

    return await create_pull_request(
        ctx.db, ctx.repository_id, ctx.user_id,
        title=str(args.get("title") or "").strip(),
        description=args.get("body"),
        source_branch=str(args.get("source_branch") or "").strip(),
        target_branch=str(args.get("target_branch") or "").strip(),
    )


def _branch_state(repo_path: str, branch: str) -> Tuple[bool, Optional[str]]:
    """检查目标分支能否直接写入，返回 ``(是否放行, 错误说明)``。

    空仓库（尚无任何本地分支）放行——首次提交本就要建分支；已有分支的仓库
    则要求目标分支存在：底层提交函数对不存在的分支是「从 HEAD 分叉新建」，
    写错分支名（尤其是把默认分支猜成 ``main``）会静默造出一条平行分支。
    """
    import pygit2

    try:
        repo = pygit2.Repository(repo_path)
        names = sorted(repo.branches.local)
    except Exception:  # noqa: BLE001 — 仓库不可读留给统一的「仓库不存在」错误
        return True, None
    if not names or branch in names:
        return True, None
    shown = ", ".join(names[:10])
    more = f" …（共 {len(names)} 个）" if len(names) > 10 else ""
    return False, (
        f"分支 {branch} 不存在（现有分支：{shown}{more}）。"
        "省略 branch 参数即可使用仓库默认分支，或改用上面列出的分支"
    )


async def _retry_build(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    import uuid as uuid_mod

    from app.services.build_service import BuildService

    try:
        build_id = uuid_mod.UUID(str(args.get("build_id")))
    except (ValueError, TypeError):
        return {"error": "build_id 非法"}
    src = await BuildService.get_build(db=ctx.db, build_id=build_id)
    if src.repo_id != ctx.repository_id:
        return {"error": "build 不属于当前仓库"}
    # 重新触发 = 同分支/同提交新建一条 pending 构建（外部 runner 轮询/回调）
    build = await BuildService.create_build(
        db=ctx.db, repo_id=ctx.repository_id, branch=src.branch,
        commit_sha=src.commit_sha, commit_message=src.commit_message,
        triggered_by=ctx.user_id,
    )
    await ctx.db.commit()
    return {
        "id": str(build.id), "branch": build.branch,
        "commit_sha": build.commit_sha, "status": build.status,
    }


async def _commit_file(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.models.repository import Repository
    from app.models.user import User
    from app.services.repository_browser_service import commit_file

    path = str(args.get("path") or "").strip()
    if not path:
        return {"error": "path 为空"}
    if ctx.repo_path is None:
        return {"error": "仓库物理路径不可用"}

    # 分支：未指定时用仓库配置的默认分支（而不是猜 main）；指定则必须存在
    branch = str(args.get("branch") or "").strip()
    if not branch:
        repo_row = await ctx.db.get(Repository, ctx.repository_id)
        branch = (repo_row.default_branch if repo_row else None) or "master"
    allowed, err = await asyncio.to_thread(_branch_state, ctx.repo_path, branch)
    if not allowed:
        return {"error": err}

    user = await ctx.db.get(User, ctx.user_id) if ctx.user_id else None

    # 作者标记内容产出方（内置 Agent），提交者保留触发本次操作的用户：
    # 一条提交既能看出「是 Agent 写的」，也能追溯「是谁让它写的」
    from app.services.agent_service import AgentService

    bot = await AgentService().ensure_bot_user(ctx.db)

    # agent 本地写同过保护裁决（拒绝时回灌模型，不产生写副作用）
    from app.core.exception import AuthorizationException
    from app.services.git_event_service import ensure_local_write
    try:
        await ensure_local_write(ctx.db, ctx.repository_id, branch)
    except AuthorizationException as e:
        return {"error": str(e.detail)}

    return await commit_file(
        ctx.repo_path,
        branch,
        path,
        str(args.get("content") or ""),
        author_name=(bot.full_name or bot.username),
        author_email=bot.email,
        message=str(args.get("message") or f"Update {path}"),
        committer_name=(user.username if user and user.username else bot.username),
        committer_email=(user.email if user and user.email else bot.email),
    )


# --------------------------- 注册 ---------------------------

def load_write_tools() -> None:
    """注册 server-plane 写工具（幂等）"""
    global _LOADED
    if _LOADED:
        return
    _LOADED = True

    register_tool(ToolSpec(
        name="create_issue",
        description="在仓库创建一个 Issue（写操作，需写权限）。",
        parameters={
            "type": "object",
            "properties": {
                "title": {"type": _P, "description": "标题"},
                "body": {"type": _P, "description": "描述"},
                "priority": {"type": _P, "description": "low/medium/high"},
            },
            "required": ["title"],
        },
        handler=_create_issue,
        scope=SCOPE_WRITE,
        requires_approval=True,
    ))
    register_tool(ToolSpec(
        name="comment_on_issue",
        description="在指定 Issue 下发表评论（写操作，需写权限）。",
        parameters={
            "type": "object",
            "properties": {
                "number": {"type": "integer", "description": "Issue 编号"},
                "body": {"type": _P, "description": "评论内容"},
            },
            "required": ["number", "body"],
        },
        handler=_comment_on_issue,
        scope=SCOPE_WRITE,
        requires_approval=True,
    ))
    register_tool(ToolSpec(
        name="comment_on_pull_request",
        description="在指定 PR 下发表评论（写操作，需写权限）。",
        parameters={
            "type": "object",
            "properties": {
                "number": {"type": "integer", "description": "PR 编号"},
                "body": {"type": _P, "description": "评论内容"},
            },
            "required": ["number", "body"],
        },
        handler=_comment_on_pull_request,
        scope=SCOPE_WRITE,
        requires_approval=True,
    ))
    register_tool(ToolSpec(
        name="create_pull_request",
        description="创建 Pull Request（写操作，需写权限）。",
        parameters={
            "type": "object",
            "properties": {
                "title": {"type": _P, "description": "标题"},
                "body": {"type": _P, "description": "描述"},
                "source_branch": {"type": _P, "description": "源分支"},
                "target_branch": {"type": _P, "description": "目标分支"},
            },
            "required": ["title", "source_branch", "target_branch"],
        },
        handler=_create_pull_request,
        scope=SCOPE_WRITE,
        requires_approval=True,
    ))
    register_tool(ToolSpec(
        name="commit_file",
        description="在指定分支创建/更新文件并提交（写操作，需写权限）。省略 branch 时使用仓库默认分支。",
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": _P, "description": "文件路径"},
                "content": {"type": _P, "description": "文件内容"},
                "branch": {"type": _P, "description": "分支名（省略则用仓库默认分支；须为已存在分支）"},
                "message": {"type": _P, "description": "提交信息"},
            },
            "required": ["path", "content"],
        },
        handler=_commit_file,
        scope=SCOPE_WRITE,
        requires_approval=True,
    ))
    register_tool(ToolSpec(
        name="retry_build",
        description="按构建 ID 重新触发构建（同分支/同提交新建一条 pending 构建；写操作，需审批）。",
        parameters={
            "type": "object",
            "properties": {
                "build_id": {"type": _P, "description": "要重试的构建 ID"},
            },
            "required": ["build_id"],
        },
        handler=_retry_build,
        scope=SCOPE_WRITE,
        requires_approval=True,
    ))
    register_tool(ToolSpec(
        name="apply_label",
        description="给指定 Issue 添加标签（写操作，需审批）。",
        parameters={
            "type": "object",
            "properties": {
                "number": {"type": "integer", "description": "Issue 编号"},
                "label": {"type": _P, "description": "标签名"},
            },
            "required": ["number", "label"],
        },
        handler=_apply_label,
        scope=SCOPE_WRITE,
        requires_approval=True,
    ))
    register_tool(ToolSpec(
        name="set_priority",
        description="设置指定 Issue 的优先级（写操作，需审批）。",
        parameters={
            "type": "object",
            "properties": {
                "number": {"type": "integer", "description": "Issue 编号"},
                "priority": {"type": _P, "description": "low/medium/high/critical"},
            },
            "required": ["number", "priority"],
        },
        handler=_set_priority,
        scope=SCOPE_WRITE,
        requires_approval=True,
    ))
