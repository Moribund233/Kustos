"""数据库配置存储：读取与播种 ``app_config`` 表。

核心约束：
- **引导层键永不入表**：``database`` 连接参数（读表前必须先有连接，鸡生蛋）、
  ``security.secret_key``（拖库即可伪造 token）。env 始终高于 DB。
- **种子来源** ``config.example.toml``（保留其注释的文档价值），缺键补齐、
  不覆盖既有值 → 幂等；与 pydantic 字段集比对后丢弃未知键（防模板与字段
  定义漂移打崩启动）。
- **读取失败一律降级**（表未建 / 连接超时 / 未配 URL）→ 返回 ``None``，调用方
  退回 env + 默认值，不打崩启动——与坏配置源同语义。

URL 解析只读**环境变量**（``DATABASE_URL`` / ``KUSTOS_DATABASE_URL``）：本模块
在 ``ConfigManager`` 构造期间被调用，此时 ``Config`` 尚未建好，任何
``get_config()`` 调用都会递归。
"""
from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple, get_args, get_origin

from app.core.config_schema import bootstrap_excluded_keys as _bootstrap_excluded_keys
from app.core.constants import PROJECT_ROOT
from app.core.db_url import sync_db_url

logger = logging.getLogger(__name__)

TABLE_NAME = "app_config"
SECRETS_TABLE_NAME = "config_secrets"

#: 密钥明文的进程内缓存 TTL（秒）——与配置 TTL 轮询同量级；本进程写入后
#: 主动失效（``invalidate_secret_cache``），其余进程 ≤TTL 收敛
_SECRET_TTL = 5.0
_secret_cache: Dict[Tuple[str, str], Tuple[Optional[str], float]] = {}
_secret_lock = threading.Lock()

#: 引导层：**整节**不入表（当前为空——保留机制以备后续「读表前必须可用」的键）
BOOTSTRAP_EXCLUDED_SECTIONS = frozenset()

#: 引导层：按节排除的键——由 ``core/config_schema.SECTION_META`` 一处派生
#: （``config_schema`` 不在导入期触碰 ``core.config``，无 ConfigManager 构造期
#: 的递归风险）。与前端 `configField.ts READONLY_FIELDS`
#: 对齐：`database.url` 读表前必须先有连接（鸡生蛋）、`is_stress_test` 属部署
#: 开关、`security.secret_key` 拖库即可伪造 token。三者只走 env。
BOOTSTRAP_EXCLUDED_KEYS: Dict[str, frozenset] = _bootstrap_excluded_keys()


def _example_path() -> Path:
    return PROJECT_ROOT / "config.example.toml"


def _resolve_sync_url(db_url: Optional[str] = None) -> Optional[str]:
    """解析同步连接串（只看环境变量，避免递归进 ConfigManager）。

    实现见 :mod:`app.core.db_url`：SQLAlchemy 2.x 对裸 ``postgresql://`` 默认
    psycopg3，而本项目只装 psycopg2，须显式固定驱动。
    """
    url = (db_url or os.environ.get("DATABASE_URL") or os.environ.get("KUSTOS_DATABASE_URL") or "").strip()
    if not url:
        return None
    return sync_db_url(url)


def _make_engine(url: str):
    from sqlalchemy import create_engine

    connect_args: Dict[str, Any] = {
        # 冷启动读一行配置不应拖住进程：连接超时有界
        "connect_timeout": 5
    }
    return create_engine(url, pool_pre_ping=True, future=True, connect_args=connect_args)


def _payload_to_dict(value: Any) -> Dict[str, Any]:
    """JSON 列归一：psycopg2 解析为 dict，字符串形态兜底。"""
    if isinstance(value, dict):
        return value
    if isinstance(value, (str, bytes, bytearray)):
        try:
            import json

            parsed = json.loads(value)
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _section_model(section: str):
    """节名 → 对应的 pydantic 配置节类；未知/非节模型 → ``None``"""
    from types import UnionType
    from typing import Union

    from app.core.config import Config

    field = Config.model_fields.get(section)
    if field is None:
        return None
    ann = field.annotation
    if get_origin(ann) in (Union, UnionType):
        ann = next((a for a in get_args(ann) if a is not type(None)), None)
    if isinstance(ann, type) and hasattr(ann, "model_fields"):
        return ann
    return None


def _section_fields() -> Dict[str, frozenset]:
    """节名 → pydantic 字段名集合（用于剔除模板里的死键/未知键）"""
    from app.core.config import Config

    out: Dict[str, frozenset] = {}
    for name in Config.model_fields:
        model = _section_model(name)
        if model is not None:
            out[name] = frozenset(model.model_fields)
    return out


def example_seed_data() -> Dict[str, Dict[str, Any]]:
    """从 ``config.example.toml`` 计算播种数据（已剔除引导层与未知键）。

    Returns:
        ``{section: {key: value}}``；模板缺失/不可解析时返回 ``{}``（告警一次）。
    """
    import toml

    path = _example_path()
    if not path.exists():
        logger.warning("配置模板 %s 不存在，跳过播种", path)
        return {}
    try:
        raw = toml.load(str(path))
    except Exception as e:  # noqa: BLE001 — 模板坏不应打崩 init
        logger.error("解析配置模板失败，跳过播种: %s", e)
        return {}

    section_fields = _section_fields()
    out: Dict[str, Dict[str, Any]] = {}
    for section, values in (raw or {}).items():
        if section in BOOTSTRAP_EXCLUDED_SECTIONS:
            continue
        if not isinstance(values, dict):
            continue
        excluded = BOOTSTRAP_EXCLUDED_KEYS.get(section, frozenset())
        fields = section_fields.get(section)
        if fields is None:
            # 模板里有 Config 中不存在的节：整节丢弃并告警（字段定义漂移）
            logger.warning("配置模板含未知节 [%s]，播种时忽略", section)
            continue
        kept = {
            k: v
            for k, v in values.items()
            if k in fields and k not in excluded
        }
        dropped = sorted(set(values) - set(kept))
        if dropped:
            logger.warning("配置模板 [%s] 含未知/禁用键，播种时忽略: %s", section, dropped)
        if kept:
            out[section] = kept
    return out


def seed_from_example(db_url: Optional[str] = None) -> Dict[str, Any]:
    """把模板播种进 ``app_config``（幂等：只补缺键，不覆盖已有值）。

    Returns:
        ``{"created": n, "updated": n, "sections": n}``，或
        ``{"skipped": 原因}`` / ``{"error": 消息}``。
        失败不抛——播种失败时配置退回 env + 文件 + 默认值仍可用，init 容器
        不该因此判失败（但 error 级日志必须留痕）。
    """
    from sqlalchemy import inspect, text

    data = example_seed_data()
    if not data:
        return {"skipped": "no_seed_data"}

    url = _resolve_sync_url(db_url)
    if not url:
        return {"skipped": "no_database_url"}

    engine = _make_engine(url)
    try:
        if not inspect(engine).has_table(TABLE_NAME):
            logger.error("表 %s 不存在（迁移未执行？），无法播种配置", TABLE_NAME)
            return {"skipped": "table_missing"}

        from app.models.app_config import AppConfig

        table = AppConfig.__table__
        created = updated = 0
        with engine.begin() as conn:
            existing = {
                row.section: _payload_to_dict(row.payload)
                for row in conn.execute(
                    text(f"SELECT section, payload FROM {TABLE_NAME}")
                )
            }
            for section, values in data.items():
                current = existing.get(section)
                if current is None:
                    conn.execute(
                        table.insert().values(section=section, payload=values, version=1)
                    )
                    created += 1
                    continue
                missing = {k: v for k, v in values.items() if k not in current}
                if missing:
                    merged = {**current, **missing}
                    conn.execute(
                        table.update()
                        .where(table.c.section == section)
                        .values(payload=merged, version=table.c.version + 1)
                    )
                    updated += 1
        logger.info(
            "配置表播种完成: 新增 %s 节 / 补齐 %s 节（模板共 %s 节可播种）",
            created, updated, len(data),
        )
        return {"created": created, "updated": updated, "sections": len(data)}
    except Exception as e:  # noqa: BLE001 — 播种失败不阻断初始化
        logger.error("配置表播种失败（配置将退回 env/文件/默认值）: %s", e)
        return {"error": str(e)}
    finally:
        engine.dispose()


def _load_all() -> Optional[tuple]:
    """读全表 + ``max(version)``（同一连接）→ ``(data, version)``；失败 → ``None``。"""
    from sqlalchemy import inspect, text

    url = _resolve_sync_url()
    if not url:
        return None

    engine = _make_engine(url)
    try:
        if not inspect(engine).has_table(TABLE_NAME):
            # 迁移尚未执行（如镜像先行、init 未跑）：静默降级，不刷屏
            return None
        with engine.connect() as conn:
            rows = conn.execute(
                text(f"SELECT section, payload, version FROM {TABLE_NAME}")
            ).all()
        if not rows:
            return {}, None
        return {r.section: _payload_to_dict(r.payload) for r in rows}, max(
            r.version for r in rows
        )
    except Exception as e:  # noqa: BLE001 — 读配置失败不得打崩启动
        logger.warning("读取数据库配置失败（退回 env/默认值）: %s", e)
        return None
    finally:
        engine.dispose()


def load_all_section_values() -> Optional[Dict[str, Dict[str, Any]]]:
    """读全表 → ``{section: payload}``；任何失败返回 ``None``（调用方降级）。

    每进程在 ``ConfigManager`` 构造时调用一次，另由 TTL 变更检测周期性复用。
    """
    result = _load_all()
    return None if result is None else result[0]


def max_version(db_url: Optional[str] = None) -> Optional[int]:
    """``max(version)``——进程内配置变更检测用的廉价单行；失败/表缺失 → ``None``。"""
    from sqlalchemy import inspect, text

    url = _resolve_sync_url(db_url)
    if not url:
        return None
    engine = _make_engine(url)
    try:
        if not inspect(engine).has_table(TABLE_NAME):
            return None
        with engine.connect() as conn:
            return conn.execute(text(f"SELECT max(version) FROM {TABLE_NAME}")).scalar()
    except Exception as e:  # noqa: BLE001 — 检测失败不改变既有配置
        logger.debug("读取配置版本失败（跳过本次变更检测）: %s", e)
        return None
    finally:
        engine.dispose()


def invalidate_secret_cache(
    section: Optional[str] = None, name: Optional[str] = None
) -> None:
    """失效密钥明文缓存（本进程写入后调用；不传参 = 全清）"""
    with _secret_lock:
        if section is None:
            _secret_cache.clear()
        elif name is None:
            for key in [k for k in _secret_cache if k[0] == section]:
                del _secret_cache[key]
        else:
            _secret_cache.pop((section, name), None)


def get_secret(section: str, name: str, db_url: Optional[str] = None) -> Optional[str]:
    """读取并解密配置密钥 → 明文；无记录/表未建 → ``None``。

    进程内 5s TTL 缓存（本进程写入主动失效，跨进程 ≤TTL 收敛）。错误分层：

    - **解密失败 = 确定性错误 → 抛 ``ConfigSecretError``**（主密钥不一致、
      密文损坏、AAD 不匹配）——不得静默吞成「未配置」造成哑故障；
    - 读 IO 失败按本模块惯例降级 ``None``（与配置读失败降级一致）。

    Raises:
        ConfigSecretError: 密文无法解密（``utils/config_crypto``）
    """
    cache_key = (section, name)
    now = time.monotonic()
    with _secret_lock:
        hit = _secret_cache.get(cache_key)
        if hit is not None and now - hit[1] < _SECRET_TTL:
            return hit[0]

    from app.utils.config_crypto import ConfigSecretError, decrypt_secret

    url = _resolve_sync_url(db_url)
    if not url:
        return None
    from sqlalchemy import inspect, text

    engine = _make_engine(url)
    try:
        if not inspect(engine).has_table(SECRETS_TABLE_NAME):
            return None
        with engine.connect() as conn:
            row = conn.execute(
                text(
                    f"SELECT ciphertext FROM {SECRETS_TABLE_NAME} "
                    "WHERE section = :section AND name = :name"
                ),
                {"section": section, "name": name},
            ).scalar()
        if not row:
            return None
        plaintext = decrypt_secret(row, section=section, name=name)
    except ConfigSecretError:
        raise
    except Exception as e:  # noqa: BLE001 — IO 失败降级（与配置读同语义）
        logger.warning(
            "读取配置密钥失败（按未配置降级）: section=%s name=%s: %s",
            section, name, e,
        )
        return None
    finally:
        engine.dispose()
    with _secret_lock:
        _secret_cache[cache_key] = (plaintext, time.monotonic())
    return plaintext


def section_version(section: str, db_url: Optional[str] = None) -> int:
    """指定配置节的**行版本**（乐观锁用）；行不存在 / 表未建 / 读取失败 → 0。

    读侧把失败归为 0 是安全的：真正的 CAS 在 ``update_sections`` 的写事务内
    完成——读到 0 最多让客户端吃一次 409 后重读，不会造成丢更新。
    """
    from sqlalchemy import inspect, text

    url = _resolve_sync_url(db_url)
    if not url:
        return 0
    engine = _make_engine(url)
    try:
        if not inspect(engine).has_table(TABLE_NAME):
            return 0
        with engine.connect() as conn:
            value = conn.execute(
                text(f"SELECT version FROM {TABLE_NAME} WHERE section = :section"),
                {"section": section},
            ).scalar()
            return int(value) if value else 0
    except Exception as e:  # noqa: BLE001 — meta 增强信息，失败不阻断读
        logger.debug("读取节 [%s] 版本失败: %s", section, e)
        return 0
    finally:
        engine.dispose()


def _assert_writable(sections: Dict[str, Dict[str, Any]]) -> None:
    """引导层键拒绝写入（数据库 url / 压测开关 / 签名密钥只走 env）"""
    for section, values in sections.items():
        if section in BOOTSTRAP_EXCLUDED_SECTIONS:
            raise ValueError(f"引导层配置节 [{section}] 不允许写入数据库")
        excluded = BOOTSTRAP_EXCLUDED_KEYS.get(section, frozenset())
        bad = excluded & set(values or {})
        if bad:
            raise ValueError(
                f"[{section}] 属引导层键，只允许通过环境变量配置: {sorted(bad)}"
            )


def update_sections(
    sections: Optional[Dict[str, Dict[str, Any]]] = None,
    updated_by: Optional[Any] = None,
    db_url: Optional[str] = None,
    expected: Optional[Dict[str, int]] = None,
    secrets: Optional[Dict[str, Dict[str, Optional[str]]]] = None,
) -> Dict[str, Any]:
    """同事务**整节深合并**写入（只覆盖提交的键，同节其余键保留），``version+1``。

    语义对齐原 config.toml 写回（``_deep_merge_dicts``），并保持「先持久化、
    成功后由调用方改内存」的原子性。

    Args:
        sections: ``{节: {键: 值}}``
        updated_by: 操作者 id，落 ``app_config.updated_by``
        db_url: 覆盖连接串（测试用；缺省只读环境变量，避免递归进 ConfigManager）
        expected: 可选——``{节: 期望行版本}``，在同一读事务内做 CAS：
            实际不符抛 :class:`ConfigVersionConflictError`（行不存在视为 0）。
            用于后台表单的乐观锁，防止两个编辑者互相覆盖。
        secrets: 可选——``{节: {字段: 明文 或 None(清除)}}`**，与配置写入
            **同一事务**：加密为 ``enc:v1:`` 密文落 ``config_secrets``
            （明文不进表、不进日志）。传入本参数时该节必须有 ``expected``
            版本检查或实际写入（保证密钥不绕过乐观锁）。

    Returns:
        ``{"sections": [...], "version": N}``（N = ``max(version)`` 全局值）

    Raises:
        ValueError: 提交了引导层键 / 节模型校验失败（调用方转 4xx）
        ConfigVersionConflictError: ``expected`` 与库内行版本不符（调用方转 409）
        ConfigWriteError: 持久化失败（调用方**不得**改内存）
        ConfigSecretError: 主密钥不可用/明文非法（调用方转 500 错误码）
    """
    from app.core.config import ConfigVersionConflictError, ConfigWriteError, _deep_merge_dicts
    from app.utils.config_crypto import encrypt_secret

    clean = {
        s: dict(v) for s, v in (sections or {}).items() if isinstance(v, dict)
    }
    secret_ops: Dict[str, Dict[str, Optional[str]]] = {}
    for section, items in (secrets or {}).items():
        if not isinstance(items, dict) or not items:
            continue
        if _section_model(section) is None:
            raise ValueError(f"未知配置节 [{section}]")
        for name, plaintext in items.items():
            if not isinstance(name, str) or not name:
                raise ValueError("密钥字段名非法")
            if plaintext is not None and (not isinstance(plaintext, str) or not plaintext):
                raise ValueError(f"[{section}] 密钥明文为空（清除请传 None）")
        secret_ops[section] = dict(items)
    if not clean and not secret_ops:
        return {"sections": [], "version": None}
    if clean:
        _assert_writable(clean)

    url = _resolve_sync_url(db_url)
    if not url:
        raise ConfigWriteError("未配置数据库连接，无法保存配置")

    # 密钥在开事务前加密：主密钥不可用属确定性失败，不得留半截事务
    # （ConfigSecretError 原样上抛，由服务层转 config_secret_decrypt_failed）
    prepared: Dict[Tuple[str, str], Optional[str]] = {
        (section, name): (
            encrypt_secret(plaintext, section=section, name=name)
            if plaintext is not None
            else None
        )
        for section, items in secret_ops.items()
        for name, plaintext in items.items()
    }

    from sqlalchemy import inspect, text

    from app.models.app_config import AppConfig

    table = AppConfig.__table__
    engine = _make_engine(url)
    try:
        if not inspect(engine).has_table(TABLE_NAME):
            raise ConfigWriteError(f"表 {TABLE_NAME} 不存在（迁移未执行？）")
        with engine.begin() as conn:
            rows = {
                r.section: (_payload_to_dict(r.payload), int(r.version))
                for r in conn.execute(
                    text(f"SELECT section, payload, version FROM {TABLE_NAME}")
                )
            }
            # 仅提交密钥（values 为空）时的 CAS：密钥写入同样受乐观锁保护
            if not clean and expected:
                for section, want in expected.items():
                    actual = rows[section][1] if section in rows else 0
                    if actual != int(want):
                        raise ConfigVersionConflictError(
                            f"[{section}] 配置版本冲突：期望 {want}，实际 {actual}"
                        )
            for section, values in clean.items():
                # 乐观锁：写事务内先比对行版本再写，不留「读-改-写」窗口
                if expected and section in expected:
                    actual = rows[section][1] if section in rows else 0
                    if actual != int(expected[section]):
                        raise ConfigVersionConflictError(
                            f"[{section}] 配置版本冲突：期望 {expected[section]}，实际 {actual}"
                        )
                model = _section_model(section)
                if model is None:
                    raise ValueError(f"未知配置节 [{section}]")
                merged = _deep_merge_dicts(rows.get(section, ({}, 0))[0], values)
                # 顺手剔除历史死键（字段定义已删的键）——与读取侧的过滤同规则，
                # 写一次清一次，避免脏行长期留存
                allowed = set(model.model_fields)
                dead = [k for k in merged if k not in allowed]
                if dead:
                    logger.warning("配置节 [%s] 含死键，写入时剔除: %s", section, dead)
                    merged = {k: v for k, v in merged.items() if k in allowed}
                # 合并结果必须通过节模型校验：坏值入库后，下一次 reload 会在
                # **所有进程**的配置构造路径上抛 ValidationError 打崩启动
                try:
                    model(**merged)
                except Exception as e:  # ValidationError / 参数错误
                    raise ValueError(f"[{section}] 配置值校验失败: {e}") from e
                if section in rows:
                    conn.execute(
                        table.update()
                        .where(table.c.section == section)
                        .values(
                            payload=merged,
                            version=table.c.version + 1,
                            updated_by=updated_by,
                        )
                    )
                else:
                    conn.execute(
                        table.insert().values(
                            section=section,
                            payload=merged,
                            version=1,
                            updated_by=updated_by,
                        )
                    )
            # 密钥密文写入：与配置 CAS/写入同一事务（要么一起生效，要么一起回滚）
            if prepared:
                if not inspect(engine).has_table(SECRETS_TABLE_NAME):
                    raise ConfigWriteError(
                        f"表 {SECRETS_TABLE_NAME} 不存在（迁移未执行？）"
                    )
                from app.models.config_secret import ConfigSecret

                stable = ConfigSecret.__table__
                for (section, name), ciphertext in prepared.items():
                    existing = conn.execute(
                        text(
                            f"SELECT id FROM {SECRETS_TABLE_NAME} "
                            "WHERE section = :section AND name = :name"
                        ),
                        {"section": section, "name": name},
                    ).scalar()
                    if ciphertext is None:
                        if existing:
                            conn.execute(
                                stable.delete().where(
                                    stable.c.section == section,
                                    stable.c.name == name,
                                )
                            )
                    elif existing:
                        conn.execute(
                            stable.update()
                            .where(
                                stable.c.section == section,
                                stable.c.name == name,
                            )
                            .values(ciphertext=ciphertext, updated_by=updated_by)
                        )
                    else:
                        conn.execute(
                            stable.insert().values(
                                section=section,
                                name=name,
                                ciphertext=ciphertext,
                                updated_by=updated_by,
                            )
                        )
            new_version = conn.execute(
                text(f"SELECT max(version) FROM {TABLE_NAME}")
            ).scalar()
        # 提交成功后失效本进程密钥缓存（其余进程 ≤TTL 收敛）
        if prepared:
            for section, name in prepared:
                invalidate_secret_cache(section, name)
        logger.info(
            "配置已写入数据库: 节=%s 密钥=%s version=%s updated_by=%s",
            sorted(clean),
            sorted(f"{s}.{n}" for s, n in prepared),
            new_version,
            updated_by,
        )
        return {"sections": sorted(clean), "version": new_version}
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001 — 统一类型化，避免上层 500
        raise ConfigWriteError(f"写入配置表失败: {e}") from e
    finally:
        engine.dispose()


def reset_to_seed(db_url: Optional[str] = None) -> Dict[str, Any]:
    """把种子节的 payload **覆盖**回模板值（``version+1``），返回统计。

    语义对齐原「重置配置文件为 config.example.toml」：只重置**种子覆盖到的节**，
    引导层键永不写入。
    """
    from app.core.config import ConfigWriteError

    data = example_seed_data()
    if not data:
        return {"skipped": "no_seed_data"}

    url = _resolve_sync_url(db_url)
    if not url:
        raise ConfigWriteError("未配置数据库连接，无法重置配置")

    from sqlalchemy import inspect, text

    from app.models.app_config import AppConfig

    table = AppConfig.__table__
    engine = _make_engine(url)
    try:
        if not inspect(engine).has_table(TABLE_NAME):
            raise ConfigWriteError(f"表 {TABLE_NAME} 不存在（迁移未执行？）")
        reset = 0
        with engine.begin() as conn:
            existing = {
                r.section
                for r in conn.execute(text(f"SELECT section FROM {TABLE_NAME}"))
            }
            for section, values in data.items():
                if section in existing:
                    conn.execute(
                        table.update()
                        .where(table.c.section == section)
                        .values(payload=values, version=table.c.version + 1)
                    )
                else:
                    conn.execute(
                        table.insert().values(
                            section=section, payload=values, version=1
                        )
                    )
                reset += 1
        logger.info("配置已重置为模板默认值: %s 节", reset)
        return {"reset": reset, "sections": len(data)}
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001
        raise ConfigWriteError(f"重置配置表失败: {e}") from e
    finally:
        engine.dispose()


#: 各节字段的环境变量名特例（其余按 ``KUSTOS_{节}_{字段}`` 大写推导）
_ENV_NAME_OVERRIDES: Dict[tuple, str] = {
    ("database", "url"): "DATABASE_URL",
    ("database", "is_stress_test"): "KUSTOS_STRESS_TEST",
}


def _env_name(section: str, key: str) -> str:
    return _ENV_NAME_OVERRIDES.get(
        (section, key), f"KUSTOS_{section.upper()}_{key.upper()}"
    )


def section_sources() -> Dict[str, Dict[str, str]]:
    """``{section: {key: env|db|default}}``——供 ``GET /api/app/config`` 的 meta。

    与实际 source 链同构的三层推导（env > db > default，引导层键恒为 env/默认）；
    数据库不可用时全部降级为 ``env|default``。
    """
    payloads = load_all_section_values() or {}
    out: Dict[str, Dict[str, str]] = {}
    for section, keys in _section_fields().items():
        row: Dict[str, str] = {}
        for key in sorted(keys):
            if key in BOOTSTRAP_EXCLUDED_KEYS.get(section, frozenset()):
                # 引导层键只能来自 env（未注入即回落字段默认值）
                row[key] = "env" if os.environ.get(_env_name(section, key)) else "default"
            elif os.environ.get(_env_name(section, key)) is not None:
                row[key] = "env"
            elif key in payloads.get(section, {}):
                row[key] = "db"
            else:
                row[key] = "default"
        out[section] = row
    return out
