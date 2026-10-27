"""Agent 管理面服务（``/api/app/agent/*``）。

职责：配置读写、provider 目录、模型发现、连接测试与 key 状态。存储与跨进程
生效复用 ``app_config`` 表 + TTL 轮询，不另设机制。

安全红线（与 ``services/agent/providers.py`` 同口径）：
- key 只从**进程环境**读取；响应与日志只回环境变量名与「有没有」，绝无 key 值；
- ``base_url`` 走 ``utils/url_guard.validate_config_url``（配置级通用校验：
  仅 http/https、拒 userinfo；**不拦私网/回环**——自托管 vLLM/Ollama 就部署在
  回环，与请求级 ``validate_outbound_url`` 白名单是两种信任边界）；
- 对外 HTTP 一律带超时（``/models`` 5s、探活 10s），失败按稳定错误码上抛/软失败，
  不回显上游响应体原文（只给脱敏 message）；
- 可写键白名单 + 行版本 CAS：``api_key`` 等非配置键无处可写（白名单外 422）。

审计口径：本模块端点是**应用级**（无 repository_id），
而 ``Activity.repository_id`` 为 NOT NULL（仓库级多态审计），故不写 Activity——
``POST /api/app/agent/test-connection`` 由 ``middleware/audit_logger`` 统一记录
（非排除路径），并另记结构化业务日志（provider/base_url/结果，无 key）；
配置写回（PUT）落 ``app_config.updated_by`` 归属。
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_config
from app.core.config_schema import editable_key_sets
from app.core.exception import AuthorizationException, HttpStatusException, ValidationException
from app.services.agent.provider_catalog import ProviderCatalogEntry, catalog_list, get_entry
from app.utils.config_crypto import ConfigSecretError
from app.utils.url_guard import UrlNotAllowed, validate_config_url

logger = logging.getLogger(__name__)

#: 拉取上游 /models 的超时（5s，独立于配置读写，远端不可用不拖垮管理面）
MODELS_TIMEOUT = 5.0
#: 降级 1-token 探活的超时
PROBE_TIMEOUT = 10.0
#: 上游 /models 不支持时降级探活的触发状态码
_FALLBACK_STATUSES = (404, 405)
#: 上游拒绝凭证（key 已注入但无效/无权限）
_AUTH_STATUSES = (401, 403)

# --- 可写键白名单（写路径校验依据） ---
# 由 ``core/config_schema.SECTION_META`` 的 ``agent`` 节一处派生：
# 热键 = 节字段全集 − restart；可写全集 = 全部字段（含
# max_prompt_chars / worker_max_jobs / worker_job_timeout_seconds）。
HOT_KEYS, RESTART_KEYS = editable_key_sets("agent")
#: 可写全集 = 热生效 ∪ worker 重启生效
EDITABLE_KEYS: Tuple[str, ...] = HOT_KEYS + RESTART_KEYS


class _UpstreamAuthRejected(RuntimeError):
    """上游返回 401/403：key 已注入但被拒绝（区别于「没注入」）"""


def get_agent_admin_service() -> "AgentAdminService":
    return _service


class AgentAdminService:
    """只读配置视图 / 目录 / 模型发现 / 连接探测 / key 状态"""

    # ---------------- 配置只读视图（GET） ----------------

    def get_config_view(self) -> Dict[str, Any]:
        """``GET /api/app/agent/config`` 响应：``{config, meta}``。

        ``meta.version`` 是 **agent 节行版本**（PUT 乐观锁的凭据，行不存在 = 0）；
        ``meta.source`` 每键标注来自哪层（env/db/default），供渲染来源徽标；
        ``meta.restart_keys`` = worker 进程参数（``worker_max_jobs`` /
        ``worker_job_timeout_seconds``）——arq WorkerSettings 在启动时读取，
        修改后须重启 worker 容器才生效；其余键热生效（TTL 轮询 ≤5s 收敛）。
        ``api_key_env`` 切换到的新变量若未注入容器，由 ``key-status`` 显示未配置
        （需 recreate 注入，非 worker 重启）。
        """
        cfg = get_config().agent
        sources: Dict[str, str] = {}
        version = 0
        try:
            from app.services.config_store import section_sources, section_version

            sources = section_sources().get("agent", {}) or {}
            version = section_version("agent")
        except Exception:  # noqa: BLE001 — meta 是增强信息，绝不阻断读配置
            logger.warning("agent config meta 读取失败（sources/version 置空）", exc_info=True)
        return {
            "config": cfg.model_dump(),
            "meta": {
                "editable_keys": list(EDITABLE_KEYS),
                "hot_keys": list(HOT_KEYS),
                "restart_keys": list(RESTART_KEYS),
                "source": sources,
                "version": version,
                "writable": True,
                # key 只回「有没有/来自哪层」，模型里也没有 key 字段——
                # 结构上杜绝回显（config_secrets 与 app_config 分表）
                "key_state": self.key_state(),
            },
        }

    def key_state(self) -> Dict[str, Any]:
        """有效 LLM key 状态：``{configured, source: env|db|unset[, decrypt_failed]}``。

        源链与运行期一致（env 候选 > DB 密文）；**永不回 key 值**。
        解密失败显式标记 ``decrypt_failed``（不静默成「未配置」）。
        """
        from app.services.agent.providers import resolve_env_key
        from app.services.config_store import get_secret

        cfg = get_config().agent
        if resolve_env_key(cfg.provider)[1]:
            return {"configured": True, "source": "env"}
        try:
            db_key = get_secret("agent", "api_key")
        except ConfigSecretError as exc:
            logger.error("agent 配置密钥解密失败（key 状态按未配置回报）: %s", exc)
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
        api_key: Optional[str] = None,
        clear_api_key: bool = False,
        is_admin: bool = True,
    ) -> Dict[str, Any]:
        """``PUT /api/app/agent/config`` 响应：``{version, applied, env_overridden, key_state}``。

        校验链：可写键白名单 → ``AgentSettings`` 字段类型/范围（复用 pydantic 约束）
        → 行版本 CAS（写事务内比对，不符 409）。持久化**先于**内存生效，失败时
        运行态不变；写入进程立即生效，其余进程 ≤5s TTL 轮询收敛。

        API key 走**同事务密文落库**（``config_secrets``，AES-GCM + AAD），
        与配置写入原子提交；明文不进表、不进日志、不回响应。

        Args:
            values: 部分更新（只覆盖提交的键，同节其余键保留）
            version: 乐观锁版本（GET ``meta.version``）
            updated_by: 操作者 id（落 ``app_config.updated_by`` 审计）
            api_key: 新密钥明文（缺省 ``None`` = 不修改）
            clear_api_key: ``True`` = 删除 DB 密钥（与 ``api_key`` 互斥）
            is_admin: 当前用户是否管理员——**密钥写入仅限管理员**
                （debug 态的 danger 权限不足以换 key）

        Returns:
            ``{version, applied: {键: "immediate"}, env_overridden: [...], key_state}``
            —— ``env_overridden`` 为提交了但被环境变量压过的键（写入库中，
            读取仍取 env：部署硬约束优先；``api_key`` 同规则）。

        Raises:
            HttpStatusException: 409 版本冲突 / 422 键或值非法 / 500 密钥加密失败
            AuthorizationException: 非管理员提交密钥（``app_admin_required``）
            ValidationException: 持久化失败（``config_persist_failed``）
        """
        from app.core.config import (
            AgentSettings,
            ConfigManager,
            ConfigVersionConflictError,
            ConfigWriteError,
        )
        from app.services.config_store import section_sources, section_version

        if api_key and clear_api_key:
            raise HttpStatusException(
                status_code=422,
                detail="api_key 与 clear_api_key 不能同时提交",
                error_code="agent_config_invalid",
            )
        secrets: Optional[Dict[str, Dict[str, Optional[str]]]] = None
        if clear_api_key:
            secrets = {"agent": {"api_key": None}}
        elif api_key:
            secrets = {"agent": {"api_key": api_key}}
        if secrets and not is_admin:
            raise AuthorizationException(
                detail="修改 API key 需要管理员权限",
                error_code="app_admin_required",
            )

        submitted = dict(values or {})
        unknown = sorted(k for k in submitted if k not in EDITABLE_KEYS)
        if unknown:
            raise HttpStatusException(
                status_code=422,
                detail=f"不可写键: {unknown}（白名单见 GET meta.editable_keys）",
                error_code="agent_config_invalid",
            )
        try:
            AgentSettings(**submitted)  # 复用字段类型/范围约束（ge/le/枚举）
        except Exception as exc:  # noqa: BLE001 — pydantic ValidationError
            raise HttpStatusException(
                status_code=422, detail=str(exc), error_code="agent_config_invalid"
            ) from exc

        # env > db：提交键中由环境变量覆盖者（保存进库但读取仍取 env）
        try:
            agent_sources = section_sources().get("agent", {}) or {}
        except Exception:  # noqa: BLE001 — meta 增强信息
            agent_sources = {}
        env_overridden = sorted(k for k in submitted if agent_sources.get(k) == "env")
        # 密钥同规则：env 候选存在时 DB 密钥保存后读取仍取 env
        if secrets and self._env_key_present():
            env_overridden = sorted(set(env_overridden) | {"api_key"})

        if not submitted and not secrets:
            # 空提交不写库、不推进版本
            return {
                "version": section_version("agent"),
                "applied": {},
                "env_overridden": [],
                "key_state": self.key_state(),
            }

        try:
            manager = ConfigManager()
            manager.update_config(
                {"agent": submitted},
                updated_by=updated_by,
                expected={"agent": version},
                secrets=secrets,
            )
            # 全量 reload 而非停留在 _apply_in_memory 的就地覆盖：后者不区分来源，
            # 会把「被 env 压过」的键（如 kill switch KUSTOS_AGENT_ENABLED）真的
            # 应用进本进程——与其余进程的 env > db 语义分叉。reload 重建 Config，
            # 恢复源链优先级（管理员保存频率下代价可忽略）。
            manager.reload()
        except ConfigVersionConflictError as exc:
            raise HttpStatusException(
                status_code=409, detail=str(exc),
                error_code="agent_config_version_conflict",
            ) from exc
        except ConfigSecretError as exc:
            # 主密钥不可用：确定性失败，显式 500（配置部分已随事务回滚）
            raise HttpStatusException(
                status_code=500,
                detail=f"配置密钥加密失败（主密钥不可用？）：{exc}",
                error_code="config_secret_decrypt_failed",
            ) from exc
        except ValueError as exc:  # 节模型/引导层校验（防线二）
            raise HttpStatusException(
                status_code=422, detail=str(exc), error_code="agent_config_invalid"
            ) from exc
        except ConfigWriteError as exc:
            raise ValidationException(
                detail=str(exc), error_code="config_persist_failed"
            ) from exc

        new_version = section_version("agent")
        applied = {
            k: ("restart" if k in RESTART_KEYS else "immediate")
            for k in sorted(submitted)
        }
        if secrets:
            applied["api_key"] = "cleared" if clear_api_key else "immediate"
        restart_hits = sorted(k for k in applied if applied[k] == "restart")
        logger.info(
            "agent 配置已保存: keys=%s secret=%s version=%s updated_by=%s",
            sorted(submitted),
            "cleared" if clear_api_key else ("set" if secrets else "-"),
            new_version,
            updated_by,
        )
        return {
            "version": new_version,
            "applied": applied,
            "env_overridden": env_overridden,
            "restart_hints": (
                [f"以下配置项修改后需重启服务才能生效: {', '.join(restart_hits)}"]
                if restart_hits else []
            ),
            "key_state": self.key_state(),
        }

    @staticmethod
    def _env_key_present() -> bool:
        """是否存在可用的 env 候选 key（env > db 源链判定用）"""
        from app.services.agent.providers import resolve_env_key

        cfg = get_config().agent
        return bool(resolve_env_key(cfg.provider)[1])

    # ---------------- 用量聚合（GET /api/app/agent/usage） ----------------

    async def get_usage(self, db: AsyncSession, days: int = 7) -> Dict[str, Any]:
        """``GET /api/app/agent/usage`` 响应：按天用量 + 汇总 + 工具调用 TOP。

        聚合近 N 天（UTC 日界，空天补齐保证前端图表 x 轴连续）：
        每日作业数/成功/失败/token 合计/平均时长；工具调用次数按
        ``agent_steps(type='tool_call')`` 计数取 TOP10。只读聚合，
        ``days`` 钳制 1..90；不回显 prompt/result 等业务内容。

        Returns:
            ``{days, since, daily: [{date, jobs, succeeded, failed, tokens,
            avg_duration_s}], totals: {jobs, succeeded, failed, tokens},
            tools: [{name, calls}]}``
        """
        from datetime import datetime, timedelta, timezone

        from sqlalchemy import func, select

        from app.models.agent import AgentJob, AgentStep

        days = max(1, min(int(days), 90))
        now = datetime.now(timezone.utc)
        # 桶窗口 = 含今天（UTC）的最近 N 个日历日，查询窗口与桶对齐——
        # 保证 len(daily)==days 且每行都落在已补齐的桶里
        start_day = (now - timedelta(days=days - 1)).date()
        since = datetime.combine(start_day, datetime.min.time(), tzinfo=timezone.utc)

        rows = (
            await db.execute(
                select(
                    AgentJob.created_at,
                    AgentJob.status,
                    AgentJob.tokens_used,
                    AgentJob.started_at,
                    AgentJob.finished_at,
                ).where(AgentJob.created_at >= since)
            )
        ).all()

        def _empty(day: str) -> Dict[str, Any]:
            return {
                "date": day,
                "jobs": 0,
                "succeeded": 0,
                "failed": 0,
                "tokens": 0,
                "_dur_sum": 0.0,
                "_dur_n": 0,
            }

        daily: Dict[str, Dict[str, Any]] = {}
        for i in range(days):  # 补齐空天
            day = (start_day + timedelta(days=i)).isoformat()
            daily[day] = _empty(day)
        totals: Dict[str, int] = {"jobs": 0, "succeeded": 0, "failed": 0, "tokens": 0}

        for created, status, tokens, started, finished in rows:
            aware = created if created.tzinfo else created.replace(tzinfo=timezone.utc)
            day = aware.date().isoformat()
            bucket = daily.get(day)
            if bucket is None:  # 时钟偏差兜底
                bucket = _empty(day)
                daily[day] = bucket
            bucket["jobs"] += 1
            totals["jobs"] += 1
            if status == "succeeded":
                bucket["succeeded"] += 1
                totals["succeeded"] += 1
            elif status == "failed":
                bucket["failed"] += 1
                totals["failed"] += 1
            tok = int(tokens or 0)
            bucket["tokens"] += tok
            totals["tokens"] += tok
            if started is not None and finished is not None:
                dur = (finished - started).total_seconds()
                if dur >= 0:
                    bucket["_dur_sum"] += dur
                    bucket["_dur_n"] += 1

        daily_list = []
        for day in sorted(daily):
            b = daily[day]
            n = b.pop("_dur_n")
            s = b.pop("_dur_sum")
            b["avg_duration_s"] = round(s / n, 1) if n else None
            daily_list.append(b)

        tool_rows = (
            await db.execute(
                select(AgentStep.name, func.count())
                .where(
                    AgentStep.type == "tool_call",
                    AgentStep.created_at >= since,
                    AgentStep.name.isnot(None),
                )
                .group_by(AgentStep.name)
                .order_by(func.count().desc(), AgentStep.name)
                .limit(10)
            )
        ).all()

        return {
            "days": days,
            "since": since.isoformat(),
            "daily": daily_list,
            "totals": totals,
            "tools": [{"name": name, "calls": int(n)} for name, n in tool_rows],
        }

    # ---------------- 供应商目录 ----------------

    def list_providers(self) -> Dict[str, Any]:
        """``GET /api/app/agent/providers`` 响应：常量目录 + allow_custom"""
        return {"providers": catalog_list(), "allow_custom": True}

    # ---------------- key 状态（只回「有没有」） ----------------

    @staticmethod
    def _key_candidates(
        cfg: Any, entry: Optional[ProviderCatalogEntry]
    ) -> List[str]:
        """有序候选环境变量名：目录条目专属名在前，通用 ``api_key_env`` 兜底"""
        names: List[str] = []
        if entry:
            names.extend(entry.key_envs)
        if getattr(cfg, "api_key_env", ""):
            names.append(cfg.api_key_env)
        # 去重保序、剔空
        seen: set = set()
        ordered: List[str] = []
        for name in names:
            name = (name or "").strip()
            if name and name not in seen:
                seen.add(name)
                ordered.append(name)
        return ordered

    def resolve_api_key(
        self, entry: Optional[ProviderCatalogEntry] = None
    ) -> Optional[Tuple[str, str]]:
        """解析 key：返回 ``(来源, key)``；无可用 key → ``None``。

        源链与运行期一致：**env 候选（条目专属名 → 通用 ``api_key_env``）
        > DB 密文**（``config_secrets``，后台录入）。来源为 env 时即变量名，
        为 DB 时为 ``"db"``。key 只进内存，不写日志/响应（调用方脱敏用
        ``_sanitize``）。

        Raises:
            HttpStatusException: DB 密文解密失败（``config_secret_decrypt_failed``）
        """
        cfg = get_config().agent
        for name in self._key_candidates(cfg, entry):
            value = (os.environ.get(name) or "").strip()
            if value:
                return name, value
        from app.services.config_store import get_secret

        try:
            db_key = get_secret("agent", "api_key")
        except ConfigSecretError as exc:
            raise HttpStatusException(
                status_code=500,
                detail=f"Agent 配置密钥解密失败（主密钥不一致？）：{exc}",
                error_code="config_secret_decrypt_failed",
            ) from exc
        if db_key:
            return "db", db_key
        return None

    def get_key_status(self) -> Dict[str, Any]:
        """``GET /api/app/agent/key-status`` 响应（含分供应商扩展）。

        顶层三字段保持兼容（``env_name``/``configured``/``injection``，
        ``configured`` 现为**有效源链**判定：env 或 DB 任一可用即 true）；
        ``source`` 标注有效来源（``env``/``db``/``unset``），``decrypt_failed``
        标注 DB 密文解密失败。``providers[]`` 分供应商给出候选 env 与命中
        情况（供 UI 提示，运行期 ``get_provider`` 同样按候选顺序解析）。
        **永不返回 key 值。**
        """
        cfg = get_config().agent
        state = self.key_state()
        configured = bool(state.get("configured"))
        env_present = bool(
            cfg.api_key_env and (os.environ.get(cfg.api_key_env) or "").strip()
        )
        if env_present:
            injection = "compose_env"
        elif state.get("source") == "db":
            injection = "database"
        else:
            injection = "unset"
        providers = []
        for entry in catalog_list():
            item = get_entry(entry["id"])
            try:
                hit = self.resolve_api_key(item)
            except HttpStatusException:  # 解密失败 → 该条按未配置展示
                hit = None
            from_db = bool(hit) and hit[0] == "db"
            providers.append(
                {
                    "id": entry["id"],
                    "key_env": entry["key_env"],
                    "key_envs": entry["key_envs"],
                    "requires_key": entry["requires_key"],
                    # 只回「有没有 key」；是否必需看 requires_key
                    "configured": hit is not None,
                    "source_env": (
                        hit[0] if hit and not from_db else None
                    ),
                    "source": "db" if from_db else ("env" if hit else None),
                }
            )
        return {
            "env_name": cfg.api_key_env,
            "configured": configured,
            "injection": injection,
            "source": state.get("source", "unset"),
            "decrypt_failed": bool(state.get("decrypt_failed")),
            "providers": providers,
        }

    # ---------------- 模型发现 ----------------

    def _resolve_target(
        self, provider: Optional[str], base_url: Optional[str]
    ) -> Tuple[Optional[ProviderCatalogEntry], str]:
        """确定目标 base_url：显式传入 > 目录条目 > 当前配置；并做配置级形态校验"""
        cfg = get_config().agent
        entry = get_entry(provider)
        if provider and entry is None:
            raise ValidationException(
                f"未知 provider：{provider}", error_code="agent_provider_not_found"
            )
        if base_url is not None and str(base_url).strip():
            target = str(base_url)
        elif entry:
            target = entry.base_url
        else:
            target = cfg.base_url
        try:
            target = validate_config_url(target)
        except UrlNotAllowed as exc:
            raise ValidationException(
                str(exc), error_code="agent_base_url_forbidden"
            ) from exc
        return entry, target

    async def get_models(
        self,
        provider: Optional[str] = None,
        base_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``GET /api/app/agent/models`` 响应：服务端用 env key 代理拉取上游 ``/models``。

        失败路径：缺 key → 400 ``agent_key_missing``；形态非法 → 400
        ``agent_base_url_forbidden``；上游不可用 → 目录有静态兜底则回
        ``source="static"``，否则 502 ``agent_models_unavailable``。
        """
        entry, target = self._resolve_target(provider, base_url)
        requires_key = entry.requires_key if entry else True
        hit = self.resolve_api_key(entry)
        if requires_key and hit is None:
            candidates = ", ".join(self._key_candidates(get_config().agent, entry))
            raise ValidationException(
                f"容器未注入 {candidates} 中的任一环境变量（注入后 recreate 容器）",
                error_code="agent_key_missing",
            )
        api_key = hit[1] if hit else None

        try:
            ids = await self._http_get_models(target, api_key, timeout=MODELS_TIMEOUT)
            if not ids:
                raise RuntimeError("上游 /models 返回空列表")
            return {
                "models": [{"id": m} for m in ids],
                "source": "remote",
                "base_url": target,
                "provider": entry.id if entry else None,
            }
        except Exception as exc:  # noqa: BLE001 — 统一转错误码/静态兜底
            detail = self._sanitize(exc, api_key)
            if entry and entry.models:
                # 静态兜底目录：远端不可用不阻塞 UI 选型（source 明示来源）
                logger.warning(
                    "agent /models 拉取失败，回退静态目录 provider=%s base_url=%s err=%s",
                    entry.id, target, detail,
                )
                return {
                    "models": [{"id": m} for m in entry.models],
                    "source": "static",
                    "base_url": target,
                    "provider": entry.id,
                    "error_code": "agent_models_unavailable",
                    "error": detail,
                }
            logger.warning("agent /models 拉取失败 base_url=%s err=%s", target, detail)
            raise HttpStatusException(
                status_code=502,
                detail=detail,
                error_code="agent_models_unavailable",
            ) from exc

    # ---------------- 连接探测 ----------------

    async def test_connection(
        self,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /api/app/agent/test-connection`` 响应。

        语义：这是**管理员配置级探测**——先 ``GET /models``（轻量），
        端点不支持（404/405）则降级 1-token ``POST /chat/completions``。
        连通性结果一律**软失败**（200 + ``ok=false`` + ``error_code``，
        便于前端内联渲染徽标）；仅输入非法（base_url 形态 / 未知 provider）
        抛 400。不回显 Authorization / 上游响应体原文。
        """
        entry, target = self._resolve_target(provider, base_url)
        cfg = get_config().agent
        model_name = (model or cfg.model or "").strip() or None
        checked_at = datetime.now(timezone.utc).isoformat()
        started = time.perf_counter()

        def _result(ok: bool, **extra: Any) -> Dict[str, Any]:
            out: Dict[str, Any] = {
                "ok": ok,
                "base_url": target,
                "model": model_name,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "checked_at": checked_at,
            }
            out.update(extra)
            return out

        requires_key = entry.requires_key if entry else True
        hit = self.resolve_api_key(entry)
        if requires_key and hit is None:
            candidates = ", ".join(self._key_candidates(cfg, entry))
            return _result(
                False,
                error_code="agent_key_missing",
                error=f"容器未注入 {candidates} 中的任一环境变量",
            )
        api_key = hit[1] if hit else None

        source = "models"
        try:
            ids = await self._http_get_models(target, api_key, timeout=MODELS_TIMEOUT)
            if not ids:
                raise RuntimeError("上游 /models 返回空列表")
        except _UpstreamAuthRejected as exc:
            return _result(False, error_code="agent_upstream_auth_rejected", error=str(exc))
        except Exception as exc:  # noqa: BLE001
            if not self._is_fallback_status(exc) or not model_name:
                return _result(
                    False,
                    error_code="agent_models_unavailable",
                    error=self._sanitize(exc, api_key),
                )
            # /models 不支持 → 降级 1-token 探活
            try:
                await self._http_chat_probe(target, api_key, model_name, timeout=PROBE_TIMEOUT)
                source = "chat"
            except _UpstreamAuthRejected as exc:
                return _result(
                    False, error_code="agent_upstream_auth_rejected", error=str(exc)
                )
            except Exception as exc2:  # noqa: BLE001
                return _result(
                    False,
                    error_code="agent_models_unavailable",
                    error=self._sanitize(exc2, api_key),
                )

        result = _result(True, source=source)
        logger.info(
            "agent test-connection ok provider=%s base_url=%s source=%s latency_ms=%d",
            entry.id if entry else None, target, source, result["latency_ms"],
        )
        return result

    @staticmethod
    def _is_fallback_status(exc: Exception) -> bool:
        """上游是否以 404/405 拒绝了 ``/models``（触发探活降级）"""
        if isinstance(exc, httpx.HTTPStatusError):
            return exc.response.status_code in _FALLBACK_STATUSES
        return False

    # ---------------- HTTP 原语（测试可 monkeypatch） ----------------

    @staticmethod
    async def _http_get_models(
        base_url: str, api_key: Optional[str], timeout: float = MODELS_TIMEOUT
    ) -> List[str]:
        """``GET {base_url}/models`` → 模型 id 列表；401/403 → ``_UpstreamAuthRejected``"""
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{base_url.rstrip('/')}/models", headers=headers)
            if resp.status_code in _AUTH_STATUSES:
                raise _UpstreamAuthRejected(f"上游拒绝凭证（HTTP {resp.status_code}）")
            resp.raise_for_status()
            data = resp.json()
        items = data.get("data") if isinstance(data, dict) else data
        if not isinstance(items, list):
            raise RuntimeError("上游 /models 响应格式非预期（缺 data 数组）")
        return [str(m.get("id")) for m in items if isinstance(m, dict) and m.get("id")]

    @staticmethod
    async def _http_chat_probe(
        base_url: str,
        api_key: Optional[str],
        model: str,
        timeout: float = PROBE_TIMEOUT,
    ) -> None:
        """1-token ``POST /chat/completions`` 探活（/models 不支持时的降级）"""
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        payload = {
            "model": model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        }
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{base_url.rstrip('/')}/chat/completions",
                headers=headers,
                json=payload,
            )
            if resp.status_code in _AUTH_STATUSES:
                raise _UpstreamAuthRejected(f"上游拒绝凭证（HTTP {resp.status_code}）")
            resp.raise_for_status()

    # ---------------- 脱敏 ----------------

    @staticmethod
    def _sanitize(exc: Exception, api_key: Optional[str]) -> str:
        """异常 → 单行脱敏 message（去 key、限长；不回显上游响应体原文）"""
        msg = f"{type(exc).__name__}: {exc}"
        if api_key:
            msg = msg.replace(api_key, "***")
        if isinstance(exc, httpx.HTTPStatusError):
            msg = f"{type(exc).__name__}: upstream HTTP {exc.response.status_code}"
        return msg[:300]


_service = AgentAdminService()
