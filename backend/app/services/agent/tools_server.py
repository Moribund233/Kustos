"""server-plane 只读工具。

即现有 service 的薄适配器，进程内直调；权限由调用方（agent_service）在作业创建时
统一校验仓库读权限后，工具内不再重复鉴权。全部只读：读码 / 搜索 / 符号 / PR / Issue。
"""
from __future__ import annotations

import json
from typing import Any, Dict, List

from app.services.agent.tool_registry import ToolContext, ToolSpec, register_tool
from app.services.repository_browser_service import get_blob_content, get_tree_entries


# --------------------------- 读码 / 搜索 ---------------------------

async def _search_code(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config
    from app.services.search_service import SearchService, search_results_cap

    query = str(args.get("query") or "").strip()
    if not query:
        return {"error": "query 为空"}
    # kill switch：search.enabled=false 时工具禁用（与 search_code 短路同源）
    if not get_config().search.enabled:
        return {"error": "搜索功能已禁用", "results": [], "truncated": False, "source": "none"}
    # 工具 cap 派生自 search.max_results（service 侧夹取是最终裁决方）
    max_results = min(int(args.get("max_results") or 20), search_results_cap())
    res = await SearchService().search_code(
        ctx.db, ctx.repository_id, ctx.repo_path, query,
        path=args.get("path"), max_results=max_results,
    )
    results: List[Dict[str, Any]] = []
    for r in res.results:
        item: Dict[str, Any] = {"file": r.file, "line": r.line, "content": r.content}
        if r.chunk is not None:
            item["symbol"] = r.chunk.symbol
            item["span"] = [r.chunk.start_line, r.chunk.end_line]
        results.append(item)
    return {
        "query": query,
        "results": results,
        "truncated": res.truncated,
        # 溯源：index=块级索引召回；git_tree=现场全扫兜底（索引缺失/超限/非默认分支），
        # 此时结果不带 symbol/span、覆盖面可能不全，模型应据此降低置信度
        "source": res.source,
        "semantic_used": res.semantic_used,
    }


async def _find_definition(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config
    from app.services.search_service import SearchService

    name = str(args.get("name") or "").strip()
    if not name:
        return {"error": "name 为空"}
    # kill switch：search.enabled=false 时工具禁用（与 search_code 同口径）
    if not get_config().search.enabled:
        return {"error": "搜索功能已禁用", "definitions": [], "source": "none", "partial": False}
    result = await SearchService().find_definition(
        ctx.db, ctx.repository_id, name,
        exclude_tests=bool(args.get("exclude_tests", False)),
        repo_path=ctx.repo_path, ref=str(args.get("ref") or "") or None,
    )
    return {
        "name": name,
        "definitions": [
            {"file": h.file, "symbol": h.symbol, "kind": h.kind,
             "start_line": h.start_line, "end_line": h.end_line}
            for h in result.hits
        ],
        "source": result.source,
        "partial": result.partial,
    }


async def _find_usages(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config
    from app.services.search_service import SearchService, search_results_cap

    name = str(args.get("name") or "").strip()
    if not name:
        return {"error": "name 为空"}
    # kill switch：search.enabled=false 时工具禁用
    if not get_config().search.enabled:
        return {"error": "搜索功能已禁用", "usages": [], "source": "none", "partial": False}
    result = await SearchService().find_usages(
        ctx.db, ctx.repository_id, name,
        # 工具 cap 派生自 search.max_results（原 300 硬上限随之收敛）
        max_results=min(int(args.get("max_results") or 100), search_results_cap()),
        exclude_tests=bool(args.get("exclude_tests", False)),
        repo_path=ctx.repo_path, ref=str(args.get("ref") or "") or None,
    )
    return {
        "name": name,
        "usages": [
            {"file": h.file, "line": h.line, "symbol": h.symbol,
             "start_line": h.start_line, "end_line": h.end_line}
            for h in result.hits
        ],
        "source": result.source,
        "partial": result.partial,
    }


async def _read_file(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config

    path = str(args.get("path") or "").strip()
    if not path:
        return {"error": "path 为空"}
    ref = str(args.get("ref") or "HEAD")
    data = await get_blob_content(ctx.repo_path, ref=ref, path=path)
    content = data.get("content") or ""
    lines = content.splitlines()
    total = len(lines)
    if total == 0:
        return {
            "file": path, "start_line": 0, "end_line": 0,
            "total_lines": 0, "content": "", "truncated": False,
        }
    start = max(1, int(args.get("start_line") or 1))
    end = min(total, int(args.get("end_line") or total))
    if end < start:
        end = start
    text = "\n".join(lines[start - 1:end])
    # 工具自夹取：超限显式置 truncated，避免依赖 runtime 兜底（兜底会切 JSON）
    text, truncated = _clamp_text(text, get_config().agent.read_file_max_chars)
    return {
        "file": path, "language": data.get("language"),
        "start_line": start, "end_line": end, "total_lines": total,
        "content": text, "truncated": truncated,
    }


async def _list_tree(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config

    path = str(args.get("path") or "")
    data = await get_tree_entries(
        ctx.repo_path, ref=str(args.get("ref") or "HEAD"), path=path
    )
    entries = data.get("entries") or []
    cap = get_config().agent.list_tree_max_entries
    return {"path": path, "entries": entries[:cap], "truncated": len(entries) > cap}


# --------------------------- PR / Issue ---------------------------

async def _list_pull_requests(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config
    from app.services.pull_request_service import list_pull_requests

    data = await list_pull_requests(
        ctx.db, ctx.repository_id,
        status=args.get("status"),
        limit=min(int(args.get("limit") or 20), get_config().agent.list_items_max),
    )
    return _trim_list(data, "pull_requests")


async def _get_pull_request(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.pull_request_service import get_pull_request

    number = int(args.get("number") or 0)
    if number <= 0:
        return {"error": "number 非法"}
    return await get_pull_request(ctx.db, ctx.repository_id, number, include_details=True)


async def _list_issues(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config
    from app.services.issue_service import list_issues

    assignee_id = None
    assignee = str(args.get("assignee") or "").strip()
    if assignee:
        from sqlalchemy import select

        from app.models.user import User

        user = (
            await ctx.db.execute(select(User).where(User.username == assignee))
        ).scalar_one_or_none()
        if user is None:
            return {"error": f"用户不存在: {assignee}"}
        assignee_id = user.id

    data = await list_issues(
        ctx.db, ctx.repository_id,
        status=args.get("status"),
        label=args.get("label"),
        assignee_id=assignee_id,
        limit=min(int(args.get("limit") or 20), get_config().agent.list_items_max),
    )
    out = _trim_list(data, "issues")
    # priority 不在 service 过滤面内：取回后本地过滤（有界）
    priority = str(args.get("priority") or "").strip()
    if priority:
        items = [
            i for i in (out.get("items") or [])
            if isinstance(i, dict) and i.get("priority") == priority
        ]
        return {"items": items, "total": len(items), "priority_filter": priority}
    return out


# --------------------------- 成员 / 责任域 ---------------------------

async def _list_members(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from sqlalchemy import select

    from app.core.config import get_config
    from app.models.repository_member import RepositoryMember
    from app.models.user import User

    role = str(args.get("role") or "").strip()
    stmt = (
        select(RepositoryMember, User)
        .join(User, User.id == RepositoryMember.user_id)
        .where(
            RepositoryMember.repository_id == ctx.repository_id,
            RepositoryMember.is_active.is_(True),
        )
    )
    if role:
        stmt = stmt.where(RepositoryMember.role == role)
    rows = (await ctx.db.execute(stmt)).all()
    cap = get_config().agent.list_items_max
    members = [
        {"username": u.username, "name": u.full_name, "role": m.role}
        for m, u in rows
    ]
    return {"members": members[:cap], "truncated": len(members) > cap}


async def _responsible_for(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from collections import Counter

    from sqlalchemy import select

    from app.core.config import get_config
    from app.models.commit import Commit
    from app.models.repo_commit_file import RepoCommitFile

    path = str(args.get("path") or "").strip().rstrip("/")
    if not path:
        return {"error": "path 为空"}
    if ctx.db is None or ctx.repository_id is None:
        return {"path": path, "authors": [], "source": "none"}

    await _ensure_commit_index(ctx)
    rows = (
        await ctx.db.execute(
            select(RepoCommitFile.commit_sha).where(
                RepoCommitFile.repository_id == ctx.repository_id,
                RepoCommitFile.path.like(path + "%"),
            )
        )
    ).scalars().all()
    shas = set(rows)
    if not shas:
        return {"path": path, "authors": [], "commits_scanned": 0, "source": "commit_index"}

    author_rows = (
        await ctx.db.execute(
            select(Commit.author_name).where(
                Commit.repository_id == ctx.repository_id, Commit.hash.in_(shas)
            )
        )
    ).scalars().all()
    by_author = Counter(name or "unknown" for name in author_rows)
    limit = min(max(1, int(args.get("limit") or 10)), get_config().agent.list_items_max)
    authors = [{"author": a, "commits": n} for a, n in by_author.most_common(limit)]
    return {
        "path": path,
        "authors": authors,
        "commits_scanned": len(shas),
        "source": "commit_index",
    }


# --------------------------- 聊天 / 知识域 ---------------------------

async def _list_channel_messages(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    import uuid as uuid_mod
    from datetime import datetime

    from app.core.config import get_config
    from app.services.realtime.chat_service import ChatService

    if ctx.user_id is None:
        return {"error": "缺少用户上下文"}
    try:
        room_id = uuid_mod.UUID(str(args.get("room")))
    except (ValueError, TypeError):
        return {"error": "room 非法"}

    since = None
    raw_since = str(args.get("since") or "").strip()
    if raw_since:
        try:
            since = datetime.fromisoformat(raw_since.replace("Z", "+00:00"))
        except ValueError:
            return {"error": "since 非法（需 ISO 时间）"}

    # 读写走权限边界：get_messages 内部校验房间成员资格
    data = await ChatService.get_messages(
        ctx.db, room_id, ctx.user_id,
        limit=min(int(args.get("limit") or 30), get_config().agent.list_items_max),
        q=args.get("q"),
        after=since,
    )
    return {
        "messages": [
            {
                "sender": m.get("sender_username"),
                "message_type": m.get("message_type"),
                "content": (m.get("content") or "")[:2000],
                "created_at": m.get("created_at"),
            }
            for m in (data.get("messages") or [])
        ],
        "has_more": data.get("has_more"),
    }


async def _search_chat_decisions(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config
    from app.services.realtime.chat_service import ChatService

    if ctx.user_id is None:
        return {"error": "缺少用户上下文"}
    query = str(args.get("query") or "").strip()
    if not query:
        return {"error": "query 为空"}
    # 仅搜索当前用户已加入的活跃房间（平台私有语料，走权限边界）
    data = await ChatService.search_messages(
        ctx.db, ctx.user_id, query,
        limit=min(int(args.get("limit") or 20), get_config().agent.list_items_max),
    )
    return {
        "messages": [
            {
                "room_name": m.get("room_name"),
                "sender": m.get("sender_username"),
                "content": (m.get("content") or "")[:2000],
                "created_at": m.get("created_at"),
            }
            for m in (data.get("messages") or [])
        ]
    }


async def _get_issue(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.issue_service import get_issue

    number = int(args.get("number") or 0)
    if number <= 0:
        return {"error": "number 非法"}
    return await get_issue(ctx.db, ctx.repository_id, number, include_details=True)


# --------------------------- 变更 / 审查 ---------------------------

async def _list_commits(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config
    from app.services.repository_browser_service import get_commits

    data = await get_commits(
        ctx.repo_path,
        ref=str(args.get("ref") or "HEAD"),
        path=args.get("path") or None,
        page=max(1, int(args.get("page") or 1)),
        per_page=min(int(args.get("per_page") or 20), get_config().agent.list_items_max),
    )
    commits = data.get("commits") or []
    return {
        "commits": [
            {
                "sha": c.get("sha"),
                "message": c.get("message"),
                "author": (c.get("author") or {}).get("name"),
                "date": c.get("date"),
            }
            for c in commits
        ],
        "pagination": data.get("pagination"),
        "is_empty": data.get("is_empty", False),
    }


async def _get_commit(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config
    from app.services.repository_browser_service import get_commits, get_diff

    ref = str(args.get("ref") or "").strip()
    if not ref:
        return {"error": "ref 为空"}
    # 用提交历史接口取元信息（含 parents），比另开一次解析更稳
    hist = await get_commits(ctx.repo_path, ref=ref, page=1, per_page=1)
    commits = hist.get("commits") or []
    if not commits:
        return {"error": f"提交不存在: {ref}"}
    meta = commits[0]
    parents = meta.get("parents") or []
    # 根提交无父 → base=None（get_diff 对空树对比）
    diff = await get_diff(ctx.repo_path, base=(parents[0] if parents else None), head=meta["sha"])
    files = diff.get("files") or []
    result: Dict[str, Any] = {
        "sha": meta["sha"],
        "message": meta["message"],
        "author": (meta.get("author") or {}).get("name"),
        "date": meta.get("date"),
        "parents": parents,
        "files": _regions(files),
        "stats": diff.get("stats"),
    }
    if bool(args.get("include_patch", False)):
        # 正文默认不回灌；显式请求时给有界 patch，超出置 truncated
        patch, patch_truncated = _render_patch(files, get_config().agent.read_file_max_chars)
        result["patch"] = patch
        result["patch_truncated"] = patch_truncated
    return result


async def _get_diff(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config
    from app.services.repository_browser_service import get_diff

    head = str(args.get("head") or "").strip()
    if not head:
        return {"error": "head 为空"}
    base = str(args.get("base") or "").strip() or None
    diff = await get_diff(ctx.repo_path, base=base, head=head)
    files = diff.get("files") or []
    path = str(args.get("path") or "").strip()
    if path:
        files = [f for f in files
                 if (f.get("new_path") or f.get("old_path") or "").startswith(path)]
    result: Dict[str, Any] = {"files": _regions(files), "stats": diff.get("stats")}
    if bool(args.get("include_patch", False)):
        patch, patch_truncated = _render_patch(files, get_config().agent.read_file_max_chars)
        result["patch"] = patch
        result["patch_truncated"] = patch_truncated
    return result


async def _blame_file(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.repository_browser_service import get_blame

    path = str(args.get("path") or "").strip()
    if not path:
        return {"error": "path 为空"}
    # 按行区间限定可选范围，避免整文件追溯回灌
    start = max(1, int(args.get("start_line") or 1))
    end = int(args.get("end_line") or 0)
    data = await get_blame(ctx.repo_path, ref=str(args.get("ref") or "HEAD"), path=path)
    hunks = data.get("hunks") or []
    selected = []
    for h in hunks:
        h_start = int(h.get("final_start_line_number") or 0)
        h_end = h_start + int(h.get("lines_in_hunk") or 0) - 1
        if h_end < start or (end and h_start > end):
            continue
        commit = h.get("commit") or {}
        selected.append({
            "start_line": h_start,
            "lines": h.get("lines_in_hunk"),
            "commit": commit.get("sha"),
            "summary": commit.get("summary"),
            "author": (commit.get("author") or {}).get("name"),
            "date": (commit.get("author") or {}).get("date"),
        })
    return {"path": path, "ref": data.get("ref"), "hunks": selected,
            "is_empty": data.get("is_empty", False)}


async def _compare_refs(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config
    from app.services.repository_browser_service import compare

    base = str(args.get("base") or "").strip()
    head = str(args.get("head") or "").strip()
    if not base or not head:
        return {"error": "base / head 均必填"}
    data = await compare(ctx.repo_path, base=base, head=head)
    commits = data.get("commits") or []
    cap = get_config().agent.list_items_max
    return {
        "base": data.get("base"),
        "head": data.get("head"),
        "merge_base": data.get("merge_base"),
        "ahead_by": data.get("ahead_by"),
        "files": _regions(data.get("files") or []),
        "stats": data.get("stats"),
        "commits": [
            {"sha": c.get("sha"), "message": c.get("summary") or c.get("message")}
            for c in commits[:cap]
        ],
        "commits_truncated": len(commits) > cap,
    }


# --------------------------- 构建 / CI ---------------------------

def _build_row(build) -> Dict[str, Any]:
    return {
        "id": str(build.id),
        "branch": build.branch,
        "commit_sha": build.commit_sha,
        "status": build.status,
        "commit_message": build.commit_message,
        "failure_summary": getattr(build, "failure_summary", None),
        "started_at": build.started_at.isoformat() if build.started_at else None,
        "finished_at": build.finished_at.isoformat() if build.finished_at else None,
        "details_url": build.details_url,
    }


async def _get_build_status(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config
    from app.services.build_service import BuildService

    builds = await BuildService.get_builds_for_repository(
        ctx.db, ctx.repository_id,
        limit=min(int(args.get("limit") or 20), get_config().agent.list_items_max),
        branch=args.get("branch"), status=args.get("status"),
    )
    return {"builds": [_build_row(b) for b in builds]}


async def _get_build_logs(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    import uuid as uuid_mod

    from sqlalchemy import func, select

    from app.models.build_log_entry import BuildLogEntry
    from app.services.build_service import BuildService

    if not ctx.repository_id:
        return {"error": "缺少仓库上下文"}
    try:
        build_id = uuid_mod.UUID(str(args.get("build_id")))
    except (ValueError, TypeError):
        return {"error": "build_id 非法"}
    build = await BuildService.get_build(db=ctx.db, build_id=build_id)
    if build.repo_id != ctx.repository_id:
        return {"error": "build 不属于当前仓库"}

    # 禁整段回灌：默认尾部 tail 条 + 可选关键字过滤，单行也有界
    tail = min(max(1, int(args.get("tail") or 200)), 500)
    keyword = str(args.get("keyword") or "").strip()

    stmt = select(BuildLogEntry).where(BuildLogEntry.build_id == build_id)
    count_stmt = select(func.count()).select_from(BuildLogEntry).where(
        BuildLogEntry.build_id == build_id
    )
    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(BuildLogEntry.line.ilike(like))
        count_stmt = count_stmt.where(BuildLogEntry.line.ilike(like))

    total = int((await ctx.db.execute(count_stmt)).scalar_one())
    rows = (
        await ctx.db.execute(stmt.order_by(BuildLogEntry.seq.desc()).limit(tail))
    ).scalars().all()
    entries = [
        {"seq": r.seq, "stream": r.stream, "line": (r.line or "")[:1000]}
        for r in reversed(rows)
    ]
    return {
        "build_id": str(build_id),
        "status": build.status,
        "failure_summary": getattr(build, "failure_summary", None),
        "entries": entries,
        "total": total,
        "returned": len(entries),
        "truncated": total > len(entries),
    }


# --------------------------- 复合审查（索引 × 索引） ---------------------------

async def _ensure_commit_index(ctx: ToolContext) -> None:
    """尽力保证变更图索引新鲜（独立会话，best-effort，绝不影响工具主流程）。"""
    if not ctx.repo_path or ctx.repository_id is None:
        return
    try:
        from app.models.async_db import get_async_db_context
        from app.services.commit_index_service import CommitIndexService

        async with get_async_db_context() as idb:
            await CommitIndexService().ensure(idb, ctx.repository_id, ctx.repo_path)
    except Exception:  # noqa: BLE001 — 索引不可用则后续走现场 diff 兜底
        pass


async def _review_recent_changes(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config
    from app.services.repository_browser_service import get_commits, get_diff

    n = min(max(1, int(args.get("n_commits") or 5)), get_config().agent.list_items_max)
    ref = str(args.get("ref") or "HEAD")
    path_filter = str(args.get("path") or "").strip()

    await _ensure_commit_index(ctx)
    hist = await get_commits(ctx.repo_path, ref=ref, page=1, per_page=n)
    commits = hist.get("commits") or []
    shas = [c["sha"] for c in commits]

    rows_by_sha: Dict[str, List[Dict[str, Any]]] = {}
    if shas and ctx.db is not None and ctx.repository_id is not None:
        from sqlalchemy import select

        from app.models.repo_commit_file import RepoCommitFile

        rows = (
            await ctx.db.execute(
                select(RepoCommitFile).where(
                    RepoCommitFile.repository_id == ctx.repository_id,
                    RepoCommitFile.commit_sha.in_(shas),
                )
            )
        ).scalars().all()
        for r in rows:
            rows_by_sha.setdefault(r.commit_sha, []).append({
                "path": r.path,
                "status": r.status,
                "additions": r.additions,
                "deletions": r.deletions,
                "ranges": json.loads(r.changed_ranges or "[]"),
            })

    out = []
    for c in commits:
        files = rows_by_sha.get(c["sha"])
        source = "commit_index"
        if not files:
            # 索引缺失/未覆盖该提交 → 现场 diff 兜底，绝不静默给空
            parents = c.get("parents") or []
            diff = await get_diff(
                ctx.repo_path, base=(parents[0] if parents else None), head=c["sha"]
            )
            files = _regions(diff.get("files") or [])
            source = "diff"
        if path_filter:
            files = [f for f in files if (f.get("path") or "").startswith(path_filter)]
        out.append({
            "sha": c["sha"],
            "message": c["message"],
            "author": (c.get("author") or {}).get("name"),
            "date": c.get("date"),
            "source": source,
            "files": files,
        })
    return {"commits": out, "truncated": False}


async def _who_changed(ctx: ToolContext, args: Dict[str, Any]) -> Dict[str, Any]:
    from app.core.config import get_config

    symbol = str(args.get("symbol") or "").strip()
    path = str(args.get("path") or "").strip()
    limit = min(max(1, int(args.get("limit") or 10)), get_config().agent.list_items_max)

    start = int(args.get("start_line") or 0)
    end = int(args.get("end_line") or 0)
    approximate = False
    if symbol:
        from app.services.search_service import SearchService

        result = await SearchService().find_definition(
            ctx.db, ctx.repository_id, symbol, repo_path=ctx.repo_path
        )
        hits = result.hits or []
        if not hits:
            return {"symbol": symbol, "commits": [], "source": "none"}
        hit = hits[0]
        path = hit.file
        start, end = hit.start_line, hit.end_line
        # 符号块行号取自**当前**默认分支；历史提交的行区间可能已漂移 → 近似
        approximate = True
    if not path:
        return {"error": "需提供 symbol 或 path"}

    if ctx.db is None or ctx.repository_id is None:
        return {"commits": [], "source": "none"}

    from sqlalchemy import select

    from app.models.commit import Commit
    from app.models.repo_commit_file import RepoCommitFile

    await _ensure_commit_index(ctx)

    rows = (
        await ctx.db.execute(
            select(RepoCommitFile).where(
                RepoCommitFile.repository_id == ctx.repository_id,
                RepoCommitFile.path == path,
            )
        )
    ).scalars().all()
    # 行区间重叠（删除文件无区间，跳过）；无区间参数时按文件级匹配
    matched = []
    for r in rows:
        ranges = json.loads(r.changed_ranges or "[]")
        if start and end:
            if not any(cs <= end and ce >= start for cs, ce in ranges):
                continue
        matched.append((r, ranges))

    shas = [r.commit_sha for r, _ in matched]
    meta: Dict[str, Any] = {}
    if shas:
        for c in (
            await ctx.db.execute(
                select(Commit.hash, Commit.author_name, Commit.commit_message, Commit.commit_date)
                .where(Commit.repository_id == ctx.repository_id, Commit.hash.in_(shas))
            )
        ).all():
            meta[c.hash] = {"author": c.author_name, "message": c.commit_message,
                            "date": c.commit_date.isoformat() if c.commit_date else None}

    commits = []
    for r, ranges in matched:
        m = meta.get(r.commit_sha, {})
        commits.append({
            "sha": r.commit_sha,
            "author": m.get("author"),
            "date": m.get("date"),
            "message": (m.get("message") or "").splitlines()[0] if m.get("message") else None,
            "ranges": ranges,
            "additions": r.additions,
            "deletions": r.deletions,
        })
    # 有提交元信息则按其时间倒序；缺失的回落到索引写入序
    commits.sort(key=lambda c: (c["date"] or ""), reverse=True)
    return {
        "symbol": symbol or None,
        "path": path,
        "commits": commits[:limit],
        "truncated": len(commits) > limit,
        "approximate": approximate,
        "source": "commit_index",
    }


def _trim_list(data: Any, key: str) -> Dict[str, Any]:
    if not isinstance(data, dict):
        return {"items": data}
    items = data.get(key)
    if items is None:
        items = data.get("items") or data.get("results") or []
    return {"items": items, "total": data.get("total")}


def _regions(files):
    """把 ``_serialize_diff`` 的文件列表压成「结论+指针」：文件级统计 + 新侧改动行区间。"""
    out = []
    for f in files or []:
        ranges = []
        for h in f.get("hunks") or []:
            start = int(h.get("new_start") or 0)
            lines = int(h.get("new_lines") or 0)
            if start > 0 and lines > 0:
                ranges.append([start, start + lines - 1])
        out.append({
            "path": f.get("new_path") or f.get("old_path"),
            "status": f.get("status"),
            "additions": f.get("additions", 0),
            "deletions": f.get("deletions", 0),
            "ranges": ranges,
        })
    return out


def _render_patch(files, limit: int):
    """把文件列表渲染为有界 unified patch 文本（默认不返回正文，仅在显式请求时）。"""
    parts = []
    for f in files or []:
        old = f.get("old_path") or ""
        new = f.get("new_path") or ""
        parts.append(f"diff --git a/{old} b/{new}")
        for h in f.get("hunks") or []:
            parts.append(
                f"@@ -{h.get('old_start')},{h.get('old_lines')} "
                f"+{h.get('new_start')},{h.get('new_lines')} @@"
            )
            for ln in h.get("lines") or []:
                origin = ln.get("origin") or " "
                content = (ln.get("content") or "").rstrip("\n")
                parts.append(f"{origin}{content}")
    return _clamp_text("\n".join(parts), limit)


def _clamp_text(text: str, limit: int) -> tuple:
    """按字符上限夹取文本，返回 ``(文本, 是否截断)``。"""
    if limit > 0 and len(text) > limit:
        return text[:limit], True
    return text, False


# --------------------------- 注册 ---------------------------

_P = "string"

_LOADED = False


def load_server_tools() -> None:
    """注册 server-plane 只读工具（幂等）"""
    global _LOADED
    if _LOADED:
        return
    _LOADED = True

    register_tool(ToolSpec(
        name="search_code",
        description=(
            "在仓库代码中做子串检索，返回命中行及其所属符号块 file:start-end。"
            "结果带 source（index=块级索引召回；git_tree=现场全扫兜底，命中可能不全）"
            "与 semantic_used（语义检索是否实际参与），来源异常时勿据此断言「不存在」。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": _P, "description": "搜索关键词/子串"},
                "path": {"type": _P, "description": "可选，目录前缀"},
                "max_results": {"type": "integer", "description": "最大返回条数，默认 20"},
            },
            "required": ["query"],
        },
        handler=_search_code,
    ))
    register_tool(ToolSpec(
        name="find_definition",
        description=(
            "按精确符号名查找定义位置（跨文件）。块级索引只覆盖默认分支，"
            "分析其他分支请传 ref（将按该 ref 现场扫描，响应会带 source/partial）。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "name": {"type": _P, "description": "符号名，如 SearchService"},
                "ref": {"type": _P, "description": "分支/标签/提交，缺省为默认分支"},
                "exclude_tests": {"type": "boolean", "description": "是否排除测试文件"},
            },
            "required": ["name"],
        },
        handler=_find_definition,
    ))
    register_tool(ToolSpec(
        name="find_usages",
        description=(
            "按精确标识符名查找引用点（word 级），并给出引用点所在符号块。"
            "块级索引只覆盖默认分支，分析其他分支请传 ref。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "name": {"type": _P, "description": "标识符名"},
                "max_results": {"type": "integer", "description": "最大返回条数，默认 100"},
                "ref": {"type": _P, "description": "分支/标签/提交，缺省为默认分支"},
                "exclude_tests": {"type": "boolean", "description": "是否排除测试文件"},
            },
            "required": ["name"],
        },
        handler=_find_usages,
    ))
    register_tool(ToolSpec(
        name="read_file",
        description=(
            "读取仓库某文件的指定行区间（默认按需截断），避免整文件读取。"
            "对话历史已包含此前读过的内容：一次读全所需区间，"
            "勿重复请求重叠区间（重叠内容会随历史逐轮重放，浪费 token）。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": _P, "description": "文件路径"},
                "start_line": {"type": "integer", "description": "起始行（1-based）"},
                "end_line": {"type": "integer", "description": "结束行（含）"},
                "ref": {"type": _P, "description": "分支/提交，默认 HEAD"},
            },
            "required": ["path"],
        },
        handler=_read_file,
    ))
    register_tool(ToolSpec(
        name="list_tree",
        description="列出仓库某目录下的条目。",
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": _P, "description": "目录路径，默认根"},
                "ref": {"type": _P, "description": "分支/提交，默认 HEAD"},
            },
        },
        handler=_list_tree,
    ))
    register_tool(ToolSpec(
        name="list_pull_requests",
        description="列出仓库的 Pull Request。",
        parameters={
            "type": "object",
            "properties": {
                "status": {"type": _P, "description": "open/closed/merged 等"},
                "limit": {"type": "integer", "description": "最大条数，默认 20"},
            },
        },
        handler=_list_pull_requests,
    ))
    register_tool(ToolSpec(
        name="get_pull_request",
        description="按 PR 编号获取详情。",
        parameters={
            "type": "object",
            "properties": {"number": {"type": "integer", "description": "PR 编号"}},
            "required": ["number"],
        },
        handler=_get_pull_request,
    ))
    register_tool(ToolSpec(
        name="list_issues",
        description="列出/筛选仓库的 Issue（status / label / assignee 用户名 / priority）。",
        parameters={
            "type": "object",
            "properties": {
                "status": {"type": _P, "description": "open/closed 等"},
                "label": {"type": _P, "description": "标签名"},
                "assignee": {"type": _P, "description": "指派人用户名"},
                "priority": {"type": _P, "description": "low/medium/high/critical"},
                "limit": {"type": "integer", "description": "最大条数，默认 20"},
            },
        },
        handler=_list_issues,
    ))
    register_tool(ToolSpec(
        name="list_members",
        description="列出仓库成员（用户名/姓名/角色），可按 role 过滤——用于 @ 对的人。",
        parameters={
            "type": "object",
            "properties": {
                "role": {"type": _P, "description": "可选，admin/write/read/developer 等"},
            },
        },
        handler=_list_members,
    ))
    register_tool(ToolSpec(
        name="responsible_for",
        description=(
            "按路径（文件或目录）聚合历史提交作者，回答「这块代码谁最熟」——"
            "优先读变更图索引，缺失时尽力保鲜。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": _P, "description": "文件或目录路径"},
                "limit": {"type": "integer", "description": "最多返回作者数，默认 10"},
            },
            "required": ["path"],
        },
        handler=_responsible_for,
    ))
    register_tool(ToolSpec(
        name="list_channel_messages",
        description=(
            "列出某聊天房间的消息（可选 since ISO 时间、q 关键字），用于回顾讨论；"
            "仅限本人为成员的房间。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "room": {"type": _P, "description": "聊天房间 ID"},
                "since": {"type": _P, "description": "可选，ISO 时间（只回该时间之后的消息）"},
                "q": {"type": _P, "description": "可选，内容关键字过滤"},
                "limit": {"type": "integer", "description": "最大条数，默认 30"},
            },
            "required": ["room"],
        },
        handler=_list_channel_messages,
    ))
    register_tool(ToolSpec(
        name="search_chat_decisions",
        description=(
            "在本人可访问的聊天房间内检索消息，回答「上次我们为什么选方案 X」——"
            "平台私有语料，通用 Agent 拿不到。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": _P, "description": "检索关键词"},
                "limit": {"type": "integer", "description": "最大条数，默认 20"},
            },
            "required": ["query"],
        },
        handler=_search_chat_decisions,
    ))
    register_tool(ToolSpec(
        name="get_issue",
        description="按 Issue 编号获取详情。",
        parameters={
            "type": "object",
            "properties": {"number": {"type": "integer", "description": "Issue 编号"}},
            "required": ["number"],
        },
        handler=_get_issue,
    ))
    register_tool(ToolSpec(
        name="list_commits",
        description="列出提交历史（SHA/摘要/作者/时间）。path 限定某文件或目录的历史。",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": _P, "description": "分支/标签/提交，默认 HEAD"},
                "path": {"type": _P, "description": "可选，文件或目录路径"},
                "page": {"type": "integer", "description": "页码，默认 1"},
                "per_page": {"type": "integer", "description": "每页条数，默认 20"},
            },
        },
        handler=_list_commits,
    ))
    register_tool(ToolSpec(
        name="get_commit",
        description=(
            "审查单个提交：返回改动文件、状态、增删行数与新侧改动**行区间**"
            "（结论+指针——正文请用 read_file 按区间取，勿整文件重读）。"
            "ref 可为提交 SHA/分支/标签；include_patch=true 时附有界 unified patch。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": _P, "description": "提交 SHA / 分支 / 标签"},
                "include_patch": {"type": "boolean", "description": "是否返回 patch 正文（默认 false）"},
            },
            "required": ["ref"],
        },
        handler=_get_commit,
    ))
    register_tool(ToolSpec(
        name="get_diff",
        description=(
            "比较 base→head 的差异（base 省略则与空树对比）：返回文件级统计与新侧行区间；"
            "include_patch=true 时附有界 unified patch。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "base": {"type": _P, "description": "基准 ref（省略=空树）"},
                "head": {"type": _P, "description": "目标 ref"},
                "path": {"type": _P, "description": "可选，按路径前缀过滤"},
                "include_patch": {"type": "boolean", "description": "是否返回 patch 正文（默认 false）"},
            },
            "required": ["head"],
        },
        handler=_get_diff,
    ))
    register_tool(ToolSpec(
        name="blame_file",
        description="文件行级追溯：某段代码的每一块「谁在哪个提交改的」。可用 start_line/end_line 限定区间。",
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": _P, "description": "文件路径"},
                "ref": {"type": _P, "description": "分支/提交，默认 HEAD"},
                "start_line": {"type": "integer", "description": "可选，起始行"},
                "end_line": {"type": "integer", "description": "可选，结束行"},
            },
            "required": ["path"],
        },
        handler=_blame_file,
    ))
    register_tool(ToolSpec(
        name="compare_refs",
        description="GitHub 风格 base...head 对比：merge_base / 领先提交数 / 文件级改动统计 / 领先提交列表。",
        parameters={
            "type": "object",
            "properties": {
                "base": {"type": _P, "description": "基准 ref"},
                "head": {"type": _P, "description": "目标 ref"},
            },
            "required": ["base", "head"],
        },
        handler=_compare_refs,
    ))
    register_tool(ToolSpec(
        name="get_build_status",
        description="列出仓库最近的构建状态（含失败结构摘要）。可按 branch / status 过滤。",
        parameters={
            "type": "object",
            "properties": {
                "branch": {"type": _P, "description": "可选，按分支过滤"},
                "status": {"type": _P, "description": "可选，pending/running/success/failure/error/cancelled"},
                "limit": {"type": "integer", "description": "最大条数，默认 20"},
            },
        },
        handler=_get_build_status,
    ))
    register_tool(ToolSpec(
        name="get_build_logs",
        description=(
            "读取构建日志的**尾部**（默认 200 行）并可按关键字过滤——"
            "禁整段日志回灌；先用 get_build_status 的 failure_summary 定位，再取尾部细节。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "build_id": {"type": _P, "description": "构建 ID（build_status.id）"},
                "tail": {"type": "integer", "description": "取尾部行数，默认 200（上限 500）"},
                "keyword": {"type": _P, "description": "可选，仅返回包含该关键字的行"},
            },
            "required": ["build_id"],
        },
        handler=_get_build_logs,
    ))
    register_tool(ToolSpec(
        name="review_recent_changes",
        description=(
            "一次拿到最近 N 个提交的改动概览（每文件状态/增删/改动行区间），"
            "把审查任务的「log→diff→read×N」压缩为一次调用。优先读变更图索引，"
            "索引缺失时现场 diff 兜底（source 标注 commit_index|diff）。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "n_commits": {"type": "integer", "description": "最近提交数，默认 5"},
                "ref": {"type": _P, "description": "起点 ref，默认 HEAD"},
                "path": {"type": _P, "description": "可选，仅某路径前缀下的改动"},
            },
        },
        handler=_review_recent_changes,
    ))
    register_tool(ToolSpec(
        name="who_changed",
        description=(
            "查某符号（按定义所在块）或某文件最近被谁在哪个提交改过——审查、追责、"
            "影响面分析一击命中。传 symbol 时行区间取自当前默认分支（历史可能漂移，"
            "结果标 approximate）。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "symbol": {"type": _P, "description": "精确符号名（与 path 二选一）"},
                "path": {"type": _P, "description": "文件路径（与 symbol 二选一）"},
                "start_line": {"type": "integer", "description": "可选，行区间起点"},
                "end_line": {"type": "integer", "description": "可选，行区间终点"},
                "limit": {"type": "integer", "description": "最多返回提交数，默认 10"},
            },
        },
        handler=_who_changed,
    ))

    # 写工具（scope=repo:write，运行时校验写权限）
    from app.services.agent.tools_write import load_write_tools
    load_write_tools()
