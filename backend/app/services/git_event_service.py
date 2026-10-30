"""
Git 事件服务（pre-receive / post-receive 回调）

由 git-cgi / sshd 容器的集中 hook（docker/git-hooks/*）经
POST /api/v1/git-internal/{pre,post}-receive 调用：

- evaluate_pre_receive：保护分支裁决（拒绝删除 / 拒绝强推），供 pre-receive 决定是否放行；
- handle_post_receive：分支表全量对账 + 增量提交入库 + 触发 push / tag_push webhook
  （激活 utils/webhook_trigger 中原本零生产调用的 trigger_push_event / tag_push_event）。

设计说明与已知局限：
- 对账同步分支**存在性与 tip**（branches.commit_hash，补列）；分支保护位在
  “分支被删后重新推送”场景会丢失（受保护分支本身禁止删除，实际不发生）；
- commits 表 hash 为 **(repository_id, hash) 复合唯一**（见基线迁移 0001_initial，
  跨仓共享提交各仓各存一行；原「全局唯一」口径作废）；
  推送提交按 MAX_PUSHED_COMMITS 有界入库，超限部分留待后续推送或浏览路径补齐；
- 物理仓库不可读时对账跳过（返回错误字段），等待下一次推送自愈——post-receive
  不阻断推送。

搜索索引无需在此失效：search_code → _ensure_index 按 head_commit 懒重建（已有机制）。
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import pygit2
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exception import AuthorizationException, NotFoundException
from app.core.config import get_config_value
from app.models import Branch, Commit, Repository
from app.utils.git_utils import get_repository_storage_path

logger = logging.getLogger(__name__)

ZERO_OID = "0" * 40
#: 单次推送入库提交数上限（保护 DB 与请求时长）
#: 默认值 = 既有模块常量；运行期读 [git] push_max_commits
MAX_PUSHED_COMMITS = 200


def _push_max_commits() -> int:
    """单次推送提交数上限——读 ``git.push_max_commits``（默认 200）"""
    return int(get_config_value("git", "push_max_commits", MAX_PUSHED_COMMITS))


def _is_zero(oid: Optional[str]) -> bool:
    """全零 OID = 引用新建/删除标记（兼容 sha1/sha256 仓库长度）。"""
    return not oid or set(oid) <= {"0"}


def _pushed_blob_too_large(
    repo_path: str, old_oid: str, new_oid: str,
    max_file: int, commit_limit: Optional[int] = None,
) -> Optional[str]:
    """在推送引入的提交范围内查找首个超出单文件上限（``storage.max_file_size``）的路径。

    语义：调用方在 pre-receive 回调中（对象已落盘、ref 未更新）执行——拒绝返回
    (file, size) 即阻断本次推送，是**命令行 push 强制点**。

    - 逐新提交与其第一父做 diff（不重扫旧历史；merge 取主干）；
    - 按 ``commit_limit``（= MAX_PUSHED_COMMITS）有界遍历；
    - ``old_oid`` 全零（新分支）→ 该分支全部提交都算「新」。

    Returns:
        超限文件路径（"path (size bytes)"）；无 = None。
    """
    if max_file <= 0 or _is_zero(new_oid):
        return None
    if commit_limit is None:
        commit_limit = _push_max_commits()
    try:
        repo = pygit2.Repository(repo_path)
        new_commit = repo.revparse_single(new_oid).peel(pygit2.Commit)
    except Exception:  # noqa: BLE001 — 仓不可读由既有流程记录，不在此阻断
        return None
    try:
        walker = repo.walk(new_commit.id, pygit2.GIT_SORT_TOPOLOGICAL)
        if not _is_zero(old_oid):
            walker.hide(pygit2.Oid(hex=old_oid))
    except Exception:  # noqa: BLE001
        return None
    walked = 0
    for commit in walker:
        if walked >= commit_limit:
            break
        walked += 1
        base = commit.parents[0] if commit.parents else None
        try:
            # 方向必须是「父树(旧) → 本提交树(新)」——``diff_to_tree`` 的 **self 是
            # 旧侧**（与 repository_browser_service 同款用法）。反向会把「新增超限
            # 文件」判成 DELETED 漏掉、把「删除大文件」误伤成 ADDED。根提交无父 →
            # 先写空树再对比（空树 = 全部对象都是新引入）。
            base_tree = (
                repo[repo.TreeBuilder().write()] if base is None
                else repo[base.id].tree
            )
            diff = base_tree.diff_to_tree(commit.tree)
        except Exception:  # noqa: BLE001 — 单提交 diff 失败不应打崩裁决
            continue
        for patch in diff:
            delta = patch.delta
            if delta.status in (pygit2.GIT_DELTA_ADDED, pygit2.GIT_DELTA_MODIFIED):
                nf = delta.new_file
                if nf.size > max_file:
                    return f"{nf.path} ({nf.size} bytes)"
    return None


# =============================================================================
# pre-receive：保护分支裁决
# =============================================================================

async def evaluate_branch_ref_update(
    db: AsyncSession,
    repository_id,
    branch_name: str,
    *,
    existed_before: bool,
    deleting: bool,
    force: bool = False,
) -> Optional[str]:
    """
    单分支引用变更的保护裁决——**唯一规则实现**，pre-receive 与本地写共用。

    规则（与 API 路径 branch_service.delete_branch 的保护语义对齐）：
    - 受保护分支禁止删除（``deleting=True``）；
    - 受保护分支禁止强推（``force=True``，non-fast-forward，由 hook 计算 is_force）；
    - 分支开启 require_code_review / require_status_checks 时禁止在**既有分支**上
      直写（``existed_before=True``——必须走 PR 合并；应用侧 pygit2 本地写经
      :func:`ensure_local_write` 走同一裁决）；
    - DB 中无记录的分支无保护配置 → 放行。

    Returns:
        str | None: 拒绝原因（HTTP 403 detail）；None = 放行。
    """
    from app.services.branch_service import check_branch_protection

    try:
        protection = await check_branch_protection(repository_id, branch_name, db)
    except NotFoundException:
        # 分支尚无 DB 记录（新分支）→ 无保护配置
        return None
    if not protection.get("is_protected"):
        return None

    if deleting:
        return f"protected branch cannot be deleted: {branch_name}"
    if force:
        return f"force push is not allowed on protected branch: {branch_name}"
    if existed_before and (
        protection.get("require_code_review")
        or protection.get("require_status_checks")
    ):
        return (
            f"branch {branch_name} requires a pull request "
            f"(direct push is not allowed)"
        )
    return None


async def evaluate_pre_receive(
    db: AsyncSession,
    repository_id,
    updates: List[Dict[str, Any]],
    repo_path: Optional[str] = None,
) -> Optional[str]:
    """
    保护分支 + 大小上限裁决（hook 回调入口）。

    Args:
        repo_path: 仓库物理路径（bare）。传入时额外执行单 blob / 仓库大小校验
            （``storage.max_file_size`` / ``storage.max_repo_size``）。

    Returns:
        str | None: 拒绝原因（HTTP 403 detail，hook 回显给 pusher）；None = 放行。

    分支规则实现于 :func:`evaluate_branch_ref_update`（与本地写同一函数）。
    """
    for update in updates:
        ref = update.get("ref") or ""
        if not ref.startswith("refs/heads/"):
            continue
        branch_name = ref[len("refs/heads/"):]

        old = update.get("old") or ZERO_OID
        new = update.get("new") or ZERO_OID
        reason = await evaluate_branch_ref_update(
            db,
            repository_id,
            branch_name,
            existed_before=not _is_zero(old),
            deleting=_is_zero(new),
            force=bool(update.get("is_force")) and not _is_zero(old),
        )
        if reason:
            return reason

    # 对象已由 receive-pack 落盘、ref 尚未更新——此时目录字节数即
    # 推送后的最终大小；新提交范围内的超限 blob 逐提交 diff 定位。
    if repo_path:
        cfg = _size_limits()
        if cfg["max_repo"] > 0:
            from app.utils.git_utils import _repo_disk_size

            if _repo_disk_size(repo_path) > cfg["max_repo"]:
                return (
                    f"repository size exceeds the limit "
                    f"({cfg['max_repo'] // (1024 * 1024)}MB)"
                )
        if cfg["max_file"] > 0:
            for update in updates:
                if _is_zero(update.get("new")):
                    continue
                too_large = _pushed_blob_too_large(
                    repo_path,
                    update.get("old") or ZERO_OID,
                    update["new"],
                    cfg["max_file"],
                )
                if too_large:
                    return f"file exceeds single-file size limit: {too_large}"

    return None


def _size_limits() -> Dict[str, int]:
    """``storage`` 大小上限（helper 降级 = 字段默认值 100MB / 1GB）"""
    from app.core.config import get_config_value

    return {
        "max_file": int(get_config_value("storage", "max_file_size", 100 * 1024 * 1024)),
        "max_repo": int(get_config_value("storage", "max_repo_size", 1024 * 1024 * 1024)),
    }


# =============================================================================
# 本地写（pygit2，不经 receive-pack）：统一保护裁决
# =============================================================================

async def ensure_local_write(
    db: AsyncSession,
    repository_id,
    branch_name: str,
) -> None:
    """
    本地 pygit2 写（web editor / 协作保存 / agent commit_file）统一过保护裁决。

    与 pre-receive 同一规则实现（:func:`evaluate_branch_ref_update`）：本地写
    恒为「在既有分支 tip 上追加提交」（快进，不可能删除/强推），因此只可能
    触发「受保护且要求 review/status-check 的分支禁止直写」一条。

    Raises:
        AuthorizationException: 403（保护规则拒绝，error_code
            ``branch_direct_write_forbidden``）
    """
    reason = await evaluate_branch_ref_update(
        db, repository_id, branch_name,
        existed_before=True, deleting=False, force=False,
    )
    if reason:
        raise AuthorizationException(
            detail=reason, error_code="branch_direct_write_forbidden"
        )


async def ensure_local_branch_deletable(
    db: AsyncSession,
    repository_id,
    branch_name: str,
) -> None:
    """
    API 删分支统一过保护裁决（与 pre-receive「受保护分支禁止删除」同一规则）。

    Raises:
        AuthorizationException: 403（error_code ``branch_delete_protected_forbidden``）
    """
    reason = await evaluate_branch_ref_update(
        db, repository_id, branch_name,
        existed_before=True, deleting=True, force=False,
    )
    if reason:
        raise AuthorizationException(
            detail=reason, error_code="branch_delete_protected_forbidden"
        )


# =============================================================================
# post-receive：同步 + webhook
# =============================================================================

def _list_local_branches(repo_fs: str) -> Dict[str, str]:
    """列出磁盘上的本地分支 {name: commit_hash}（同步，线程池执行）。

    物理仓库不存在/不可读时返回空 dict（调用方跳过对账并告警）。
    """
    try:
        repo = pygit2.Repository(repo_fs)
        result: Dict[str, str] = {}
        for name in repo.branches.local:
            branch = repo.branches.local.get(name)
            if branch is not None:
                result[name] = str(branch.target)
        return result
    except Exception as e:  # noqa: BLE001 — 对账失败不阻断回调
        logger.warning("列出本地分支失败 repo=%s: %s", repo_fs, e)
        return {}


def _collect_pushed_commits(
    repo_fs: str,
    updates: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, List[Dict[str, Any]]]], Dict[str, str]]:
    """
    收集本次推送的提交（同步，线程池执行）。

    Returns:
        (all_commits, commits_by_ref, pusher)
        - all_commits: 去重后的提交（用于入库），每项含 id/branch/author/committer/
          timestamp/parents/message；
        - commits_by_ref: 按 ref 分组（用于 push webhook payload）；
        - pusher: 取最新提交的 committer（hook 无法可靠获知推送者身份，取提交者近似）。
    """
    all_commits: List[Dict[str, Any]] = []
    commits_by_ref: Dict[str, List[Dict[str, Any]]] = {}
    pusher: Dict[str, str] = {"name": "unknown", "email": "unknown@localhost"}

    try:
        repo = pygit2.Repository(repo_fs)
    except Exception as e:  # noqa: BLE001
        logger.warning("打开仓库失败，跳过提交收集 repo=%s: %s", repo_fs, e)
        return all_commits, commits_by_ref, pusher

    seen = set()
    newest_time = -1
    commit_limit = _push_max_commits()

    for update in updates:
        ref = update.get("ref") or ""
        if not ref.startswith("refs/heads/"):
            continue
        old = update.get("old") or ZERO_OID
        new = update.get("new") or ZERO_OID
        if _is_zero(new):
            # 分支删除：无提交可收集
            commits_by_ref.setdefault(ref, [])
            continue

        try:
            tip = repo.revparse_single(new).peel(pygit2.Commit)
        except Exception as e:  # noqa: BLE001 — 新 OID 解析失败（对象缺失）跳过
            logger.warning("解析推送 tip 失败 ref=%s new=%s: %s", ref, new, e)
            continue

        branch_name = ref[len("refs/heads/"):]
        group: List[Dict[str, Any]] = []
        commits_by_ref.setdefault(ref, group)

        walked = 0
        for commit in repo.walk(tip.id, pygit2.GIT_SORT_TOPOLOGICAL | pygit2.GIT_SORT_TIME):
            if not _is_zero(old) and str(commit.id) == old:
                break  # 到达推送前位置（快进）
            entry = {
                "id": str(commit.id),
                "branch": branch_name,
                "message": commit.message or "",
                "author": {"name": commit.author.name, "email": commit.author.email},
                "committer": {
                    "name": commit.committer.name,
                    "email": commit.committer.email,
                },
                "commit_time": commit.commit_time,
                "timestamp": datetime.fromtimestamp(
                    commit.commit_time, tz=timezone.utc
                ).isoformat(),
                "parents": [str(p) for p in commit.parent_ids],
            }
            group.append(entry)
            if entry["id"] not in seen:
                seen.add(entry["id"])
                all_commits.append(entry)
            if commit.commit_time > newest_time:
                newest_time = commit.commit_time
                pusher = dict(entry["committer"])

            walked += 1
            if walked >= commit_limit:
                logger.warning(
                    "单次推送提交数超过上限 %d ref=%s，超出部分未入库",
                    commit_limit, ref,
                )
                break

    return all_commits, commits_by_ref, pusher


async def handle_post_receive(
    db: AsyncSession,
    repository: Repository,
    updates: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    post-receive 主流程：分支全量对账 → 提交入库 → webhook 触发。

    全部写操作走传入的 session（由回调端点的 provider 统一提交）；
    git 读操作（pygit2）在执行器线程中运行，不阻塞事件循环。
    """
    stats: Dict[str, Any] = {
        "branches_upserted": 0,
        "branches_removed": 0,
        "commits_added": 0,
        "commits_skipped": 0,
        "webhook_events": 0,
        "error": None,
    }

    repo_fs = get_repository_storage_path(repository.path)

    # ---- 1. 分支全量对账（磁盘为真相；自愈历史漂移） ----
    # 快照时刻（DB 时钟）先于磁盘读取：删除守卫据此识别「快照之后才
    # 落库的行」——并发建支的行被本轮误删会连带丢掉保护位/默认位
    snapshot_at = (await db.execute(select(func.now()))).scalar_one()
    on_disk = await asyncio.to_thread(_list_local_branches, repo_fs)
    if not on_disk:
        stats["error"] = f"no local branches readable at {repo_fs} (skip reconcile)"

    db_branches = {
        b.name: b
        for b in (
            await db.execute(
                select(Branch).where(Branch.repository_id == repository.id)
            )
        ).scalars()
    }

    if on_disk:
        for name, tip in on_disk.items():
            row = db_branches.get(name)
            if row is None:
                db.add(Branch(repository_id=repository.id, name=name, commit_hash=tip))
                stats["branches_upserted"] += 1
            elif row.commit_hash != tip:
                # 已存在分支：tip 变化时同步（磁盘为真相）
                row.commit_hash = tip
                stats["branches_upserted"] += 1
        await db.flush()

        # 分支删除：提交行**保留**——branch_id 置 NULL，
        # 仓库级历史不随分支删除丢失；分支重建后由后续 push 重新挂靠。
        recheck: Optional[Dict[str, str]] = None
        for name, row in list(db_branches.items()):
            if name in on_disk:
                continue
            # 删前即时复核磁盘：快照到删除之间并发建出的引用不能删——
            # 行一旦删除，重建行会丢掉 is_protected/is_default 位（要等
            # 后续 push 才自愈，窗口内保护失效）
            if recheck is None:
                recheck = await asyncio.to_thread(_list_local_branches, repo_fs)
                if not recheck:
                    # 复核读不到仓库时宁可漏删（下轮对账再清），不做破坏性对齐
                    logger.warning(
                        "删除前分支复核失败，跳过本轮分支删除 repo=%s", repository.path
                    )
                    break
            if name in recheck:
                # 引用已存在：收养该行并同步 tip，保护位原样保留
                tip = recheck[name]
                if row.commit_hash != tip:
                    row.commit_hash = tip
                    stats["branches_upserted"] += 1
                continue
            # 快照之后才落库/改动的行本轮不删（并发建支/加保护窗口），
            # 留待下轮对账用新快照复核
            if (
                (row.created_at is not None and row.created_at > snapshot_at)
                or (row.updated_at is not None and row.updated_at > snapshot_at)
            ):
                logger.info(
                    "对账跳过快照后新建/改动的行（下轮复核）repo=%s branch=%s",
                    repository.path, name,
                )
                continue
            await db.execute(
                update(Commit)
                .where(Commit.branch_id == row.id)
                .values(branch_id=None)
            )
            await db.delete(row)
            del db_branches[name]
            stats["branches_removed"] += 1
        await db.flush()

        # 已存在分支的保护/默认位保持不动；新建分支行 flush 后补进映射
        for name in on_disk:
            if name not in db_branches:
                row = (
                    await db.execute(
                        select(Branch).where(
                            Branch.repository_id == repository.id,
                            Branch.name == name,
                        )
                    )
                ).scalar_one()
                db_branches[name] = row

        # 默认分支对齐（DB 默认分支在物理侧缺失时收养，已有工具函数）
        try:
            from app.services.repository_service import sync_repository_default_branch
            await sync_repository_default_branch(repository, db)
        except Exception as e:  # noqa: BLE001 — 非致命
            logger.warning("默认分支对齐失败 repo=%s: %s", repository.path, e)

    # ---- 2. 增量提交入库（有界；(repository_id, hash) 唯一，已存在则跳过） ----
    commits, commits_by_ref, pusher = await asyncio.to_thread(
        _collect_pushed_commits, repo_fs, updates
    )
    if commits:
        existing_rows = {
            row.hash: row
            for row in (
                await db.execute(
                    select(Commit).where(
                        # 存在性检查按仓库 scope（跨仓共享提交各仓各存一行）
                        Commit.repository_id == repository.id,
                        Commit.hash.in_([c["id"] for c in commits]),
                    )
                )
            ).scalars()
        }
        for entry in commits:
            branch_row = db_branches.get(entry["branch"])
            hit = existing_rows.get(entry["id"])
            if hit is not None:
                # 分支删除时保留的孤儿行（branch_id=NULL），分支重建
                # 后再次推送同提交时重新挂靠
                if hit.branch_id is None and branch_row is not None:
                    hit.branch_id = branch_row.id
                    stats["commits_reattached"] = (
                        stats.get("commits_reattached", 0) + 1
                    )
                else:
                    stats["commits_skipped"] += 1
                continue
            if branch_row is None:
                # 分支已不在（对账删除/未同步），提交无处挂靠
                stats["commits_skipped"] += 1
                continue
            new_row = Commit(
                repository_id=repository.id,
                branch_id=branch_row.id,
                hash=entry["id"],
                author_name=entry["author"]["name"] or "unknown",
                author_email=entry["author"]["email"] or "unknown@localhost",
                committer_name=entry["committer"]["name"] or "unknown",
                committer_email=entry["committer"]["email"] or "unknown@localhost",
                commit_message=entry["message"],
                commit_date=datetime.fromtimestamp(
                    entry["commit_time"], tz=timezone.utc
                ),
                parent_hashes=",".join(entry["parents"]) or None,
            )
            db.add(new_row)
            existing_rows[entry["id"]] = new_row
            stats["commits_added"] += 1
        await db.flush()

    # ---- 3. 触发 push / tag_push webhook（激活既有 trigger_* 死代码） ----
    from app.services.webhook_trigger import tag_push_event, trigger_push_event

    for ref_update in updates:
        ref = ref_update.get("ref") or ""
        old = ref_update.get("old") or ZERO_OID
        new = ref_update.get("new") or ZERO_OID
        if ref.startswith("refs/heads/"):
            await trigger_push_event(
                db,
                repository.id,
                ref,
                old,
                new,
                commits_by_ref.get(ref, []),
                pusher,
            )
            stats["webhook_events"] += 1
        elif ref.startswith("refs/tags/") and not _is_zero(new):
            await tag_push_event(db, repository.id, ref, new, pusher)
            stats["webhook_events"] += 1

    # ---- 4. 派发 Agent 触发器（事件驱动；best-effort，绝不阻断 push） ----
    from app.services.agent.triggers import AgentTriggerService

    for ref_update in updates:
        ref = ref_update.get("ref") or ""
        new = ref_update.get("new") or ZERO_OID
        if not ref.startswith("refs/heads/") or _is_zero(new):
            continue
        try:
            await AgentTriggerService().dispatch_event(
                db,
                repository.id,
                "push",
                dedup_key=f"{ref}:{new}",
                context={
                    "branch": ref[len("refs/heads/"):],
                    "sha": new,
                    "pusher": pusher.get("name") if isinstance(pusher, dict) else None,
                },
            )
        except Exception:  # noqa: BLE001 — 触发器绝不影响 push 主流程
            logger.exception("Agent 触发器派发异常 repo=%s ref=%s", repository.id, ref)

    # ---- 5. 变更图索引增量更新（best-effort，绝不阻断 push） ----
    # 独立会话：索引构建的提交/异常不污染本次 push 的事务
    try:
        from app.models.async_db import get_async_db_context
        from app.services.commit_index_service import CommitIndexService

        async with get_async_db_context() as idb:
            await CommitIndexService().ensure(idb, repository.id, repo_fs)
    except Exception:  # noqa: BLE001 — 索引失败下次 push/工具调用会自愈
        logger.exception("变更图索引更新异常 repo=%s", repository.id)

    return stats
