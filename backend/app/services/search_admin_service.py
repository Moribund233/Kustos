"""搜索/embedding 管理面服务（``/api/app/search/*``）。

embedding 是**独立于 LLM 的可选索引增强**，配置面与 LLM 链路完全分离：

- 不同配置节（``search`` vs ``agent``）、不同可写白名单；
- 不同密钥字段（``config_secrets(name=embedding_api_key)`` vs ``api_key``，
  AAD 各自绑定，互不可用）；
- 不同端点与 key 状态（``key_state`` 各自独立汇报）。

密钥处理与 agent 面同规：admin 录入 → 与配置**同一事务** AES-GCM 密文落
``config_secrets``、永不回显、解密失败显式错误码
``config_secret_decrypt_failed``。源链 env > DB（部署硬约束优先）。
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from app.core.config import get_config
from app.core.exception import (
    AuthorizationException,
    HttpStatusException,
    ValidationException,
)
from app.utils.config_crypto import ConfigSecretError

logger = logging.getLogger(__name__)

#: 可写白名单：embedding 子集（其余 search 键维持默认，不在本期管理面）
HOT_KEYS: Tuple[str, ...] = (
    "embedding_enabled",
    "embedding_model",
    "embedding_base_url",
    "embedding_dim",
    "embedding_api_key_env",
    "embedding_timeout",
)
#: 生效级别：TTL 轮询热生效 + 索引/查询侧每调用重建 provider → 恒无重启键
RESTART_KEYS: Tuple[str, ...] = ()
EDITABLE_KEYS: Tuple[str, ...] = HOT_KEYS + RESTART_KEYS


def get_search_admin_service() -> "SearchAdminService":
    return _service


class SearchAdminService:
    """embedding 配置只读视图 / 写路径 / key 状态（与 LLM 链路分离）"""

    # ---------------- 配置只读视图（GET） ----------------

    def get_config_view(self) -> Dict[str, Any]:
        """``GET /api/app/search/config`` 响应：``{config, meta}``。

        ``config`` 为 ``SearchSettings`` 全量字段——**模型里没有 key 字段**
        （密钥在 ``config_secrets`` 分表），结构上杜绝回显。
        """
        cfg = get_config().search
        sources: Dict[str, str] = {}
        version = 0
        try:
            from app.services.config_store import section_sources, section_version

            sources = section_sources().get("search", {}) or {}
            version = section_version("search")
        except Exception:  # noqa: BLE001 — meta 是增强信息，绝不阻断读配置
            logger.warning("search config meta 读取失败（sources/version 置空）", exc_info=True)
        return {
            "config": cfg.model_dump(),
            "meta": {
                "editable_keys": list(EDITABLE_KEYS),
                "hot_keys": list(HOT_KEYS),
                "restart_keys": list(RESTART_KEYS),
                "source": sources,
                "version": version,
                "writable": True,
                "key_state": self.key_state(),
            },
        }

    def key_state(self) -> Dict[str, Any]:
        """有效 embedding key 状态：``{configured, source: env|db|unset[, decrypt_failed]}``。

        与 LLM key（``agent.key_state``）完全独立；**永不回 key 值**。
        """
        cfg = get_config().search
        if cfg.embedding_api_key_env and (
            os.environ.get(cfg.embedding_api_key_env) or ""
        ).strip():
            return {"configured": True, "source": "env"}
        from app.services.config_store import get_secret

        try:
            db_key = get_secret("search", "embedding_api_key")
        except ConfigSecretError as exc:
            logger.error("embedding 配置密钥解密失败（key 状态按未配置回报）: %s", exc)
            return {"configured": False, "source": "unset", "decrypt_failed": True}
        if db_key:
            return {"configured": True, "source": "db"}
        return {"configured": False, "source": "unset"}

    # ---------------- 配置写路径（PUT） ----------------

    def update_config(
        self,
        values: Dict[str, Any],
        version: int,
        updated_by: Optional[Any] = None,
        embedding_api_key: Optional[str] = None,
        clear_embedding_api_key: bool = False,
        is_admin: bool = True,
    ) -> Dict[str, Any]:
        """``PUT /api/app/search/config`` 响应：``{version, applied, env_overridden, key_state}``。

        校验链与 agent PUT 同构：白名单 → ``SearchSettings`` pydantic 约束 →
        行版本 CAS（写事务内，不符 409）。密钥与配置同事务密文落库。

        Args:
            values: 部分更新（只覆盖提交的键）
            version: 乐观锁版本（GET ``meta.version``）
            updated_by: 操作者 id（审计）
            embedding_api_key: 新密钥明文（缺省 ``None`` = 不修改）
            clear_embedding_api_key: ``True`` = 删除 DB 密钥（与上者互斥）
            is_admin: 密钥写入仅限管理员

        Raises:
            HttpStatusException: 409 版本冲突 / 422 键或值非法 / 500 密钥加密失败
            AuthorizationException: 非管理员提交密钥（``app_admin_required``）
            ValidationException: 持久化失败（``config_persist_failed``）
        """
        from app.core.config import (
            ConfigManager,
            ConfigVersionConflictError,
            ConfigWriteError,
            SearchSettings,
        )
        from app.services.config_store import section_sources, section_version

        if embedding_api_key and clear_embedding_api_key:
            raise HttpStatusException(
                status_code=422,
                detail="embedding_api_key 与 clear_embedding_api_key 不能同时提交",
                error_code="search_config_invalid",
            )
        secrets: Optional[Dict[str, Dict[str, Optional[str]]]] = None
        if clear_embedding_api_key:
            secrets = {"search": {"embedding_api_key": None}}
        elif embedding_api_key:
            secrets = {"search": {"embedding_api_key": embedding_api_key}}
        if secrets and not is_admin:
            raise AuthorizationException(
                detail="修改 Embedding API key 需要管理员权限",
                error_code="app_admin_required",
            )

        submitted = dict(values or {})
        unknown = sorted(k for k in submitted if k not in EDITABLE_KEYS)
        if unknown:
            raise HttpStatusException(
                status_code=422,
                detail=f"不可写键: {unknown}（白名单见 GET meta.editable_keys）",
                error_code="search_config_invalid",
            )
        try:
            SearchSettings(**submitted)  # 复用字段类型/范围约束
        except Exception as exc:  # noqa: BLE001 — pydantic ValidationError
            raise HttpStatusException(
                status_code=422, detail=str(exc), error_code="search_config_invalid"
            ) from exc

        # env > db：提交键中由环境变量覆盖者（保存进库但读取仍取 env）
        try:
            search_sources = section_sources().get("search", {}) or {}
        except Exception:  # noqa: BLE001 — meta 增强信息
            search_sources = {}
        env_overridden = sorted(k for k in submitted if search_sources.get(k) == "env")
        if secrets and self._env_key_present():
            env_overridden = sorted(set(env_overridden) | {"embedding_api_key"})

        if not submitted and not secrets:
            return {
                "version": section_version("search"),
                "applied": {},
                "env_overridden": [],
                "key_state": self.key_state(),
            }

        try:
            manager = ConfigManager()
            manager.update_config(
                {"search": submitted},
                updated_by=updated_by,
                expected={"search": version},
                secrets=secrets,
            )
            # 全量 reload 恢复源链优先级（env 压过的键不被后台保存绕过）
            manager.reload()
        except ConfigVersionConflictError as exc:
            raise HttpStatusException(
                status_code=409, detail=str(exc),
                error_code="search_config_version_conflict",
            ) from exc
        except ConfigSecretError as exc:
            raise HttpStatusException(
                status_code=500,
                detail=f"配置密钥加密失败（主密钥不可用？）：{exc}",
                error_code="config_secret_decrypt_failed",
            ) from exc
        except ValueError as exc:
            raise HttpStatusException(
                status_code=422, detail=str(exc), error_code="search_config_invalid"
            ) from exc
        except ConfigWriteError as exc:
            raise ValidationException(
                detail=str(exc), error_code="config_persist_failed"
            ) from exc

        new_version = section_version("search")
        applied = {k: "immediate" for k in sorted(submitted)}
        if secrets:
            applied["embedding_api_key"] = (
                "cleared" if clear_embedding_api_key else "immediate"
            )
        logger.info(
            "search(embedding) 配置已保存: keys=%s secret=%s version=%s updated_by=%s",
            sorted(submitted),
            "cleared" if clear_embedding_api_key else ("set" if secrets else "-"),
            new_version,
            updated_by,
        )
        return {
            "version": new_version,
            "applied": applied,
            "env_overridden": env_overridden,
            "key_state": self.key_state(),
        }

    @staticmethod
    def _env_key_present() -> bool:
        """env 层 embedding key 是否可用（env > db 源链判定）"""
        cfg = get_config().search
        return bool(
            cfg.embedding_api_key_env
            and (os.environ.get(cfg.embedding_api_key_env) or "").strip()
        )

    # ---------------- 全实例索引健康度（admin 索引页） ----------------

    async def index_overview(self, db: Any) -> Dict[str, Any]:
        """``GET /api/app/search/index-overview`` 响应：每仓索引状态 + 汇总。

        每仓回传 HEAD 对齐（``in_sync``）、chunks/refs/embeddings 计数与
        ``last_indexed_at``；HEAD 批量在**单次线程**内逐仓读取（pygit2 只读
        引用，开销随仓库数线性——当前实例量级足够，上千仓时再分页/懒取）。
        与仓库设置页的单仓 ``index-status`` 同口径（HEAD 对齐 + 代次足够）。

        Returns:
            ``{repos: [{id, name, path, head_commit, indexed_commit, in_sync,
            index_generation, chunks, refs, embeddings, last_indexed_at}],
            totals: {repos, in_sync, stale, never_indexed, chunks, refs,
            embeddings}, semantic_enabled, current_generation}``
        """
        import asyncio

        from sqlalchemy import func, select

        from app.models.repo_search import RepoSearchState
        from app.models.repo_search_chunk import RepoSearchChunk
        from app.models.repo_search_ref import RepoSearchRef
        from app.models.repo_search_embedding import RepoSearchEmbedding
        from app.models.repository import Repository
        from app.services.search_service import (
            INDEX_GENERATION,
            head_commit as _head_of,
        )
        from app.utils.git_utils import get_repository_storage_path

        repos = list((await db.execute(select(Repository))).scalars().all())
        states = {
            str(s.repository_id): s
            for s in (await db.execute(select(RepoSearchState))).scalars().all()
        }

        async def _counts(model) -> Dict[str, int]:
            rows = (
                await db.execute(
                    select(model.repository_id, func.count()).group_by(
                        model.repository_id
                    )
                )
            ).all()
            return {str(rid): int(n or 0) for rid, n in rows}

        chunk_counts = await _counts(RepoSearchChunk)
        ref_counts = await _counts(RepoSearchRef)
        embedding_counts = await _counts(RepoSearchEmbedding)

        def _heads(pairs):
            return {rid: _head_of(path) for rid, path in pairs}

        pairs = [
            (str(r.id), get_repository_storage_path(r.path)) for r in repos
        ]
        heads = await asyncio.to_thread(_heads, pairs) if pairs else {}

        items: List[Dict[str, Any]] = []
        totals = {
            "repos": len(repos),
            "in_sync": 0,
            "stale": 0,
            "never_indexed": 0,
            "chunks": 0,
            "refs": 0,
            "embeddings": 0,
        }
        for r in repos:
            rid = str(r.id)
            st = states.get(rid)
            head = heads.get(rid)
            generation = (st.index_generation if st is not None else None) or 0
            never = st is None
            in_sync = bool(
                (not never)
                and head
                and st.indexed_commit == head
                and generation >= INDEX_GENERATION
            )
            chunks = chunk_counts.get(rid, 0)
            refs = ref_counts.get(rid, 0)
            embeddings = embedding_counts.get(rid, 0)
            items.append(
                {
                    "id": rid,
                    "name": r.name,
                    "path": r.path,
                    "head_commit": head,
                    "indexed_commit": st.indexed_commit if st is not None else None,
                    "index_generation": generation,
                    "in_sync": in_sync,
                    "chunks": chunks,
                    "refs": refs,
                    "embeddings": embeddings,
                    "last_indexed_at": (
                        st.updated_at.isoformat()
                        if st is not None and st.updated_at is not None
                        else None
                    ),
                }
            )
            totals["chunks"] += chunks
            totals["refs"] += refs
            totals["embeddings"] += embeddings
            if never:
                totals["never_indexed"] += 1
            elif in_sync:
                totals["in_sync"] += 1
            else:
                totals["stale"] += 1

        return {
            "repos": items,
            "totals": totals,
            "semantic_enabled": bool(get_config().search.embedding_enabled),
            "current_generation": INDEX_GENERATION,
        }


_service = SearchAdminService()
