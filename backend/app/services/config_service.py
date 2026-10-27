"""
配置管理服务层

提供配置管理功能：
- 配置读取、修改、验证
- 配置重置
- 权限检查
"""
from typing import Any, Dict, List, Optional, Tuple

import os
import re

from app.core.config import ConfigManager, _deep_merge_dicts, get_config as get_core_config, ConfigWriteError
from app.core.config_schema import SECTION_META, protected_sections, restart_required_configs, writable_sections
from app.core.exception import ValidationException, AuthorizationException

#: 脱敏占位符
MASK_PLACEHOLDER = "***"

#: ``scheme://user:password@host`` 的凭据段（database.url 脱敏用）
_URL_CREDENTIALS_RE = re.compile(r"(://)[^/@\s]+@")


class ConfigService:
    """
    配置服务类

    提供配置管理功能
    """

    #: 后台可修改的配置节——由 ``core/config_schema.SECTION_META`` 一处派生。
    #: ``database`` 保留，但其引导层键
    #: （url / is_stress_test）由保护校验拒绝写入；可写节内的
    #: ``protected_keys``（storage.repo_root / upload_root）同样逐键拒绝
    #: （见 ``_validate_config_data``）。
    ALLOWED_CONFIG_SECTIONS = writable_sections()
    #: 整节拒绝通用 PUT 的节（派生；``system`` 为无模型遗留节，保持原文案）。
    PROTECTED_CONFIG_SECTIONS = protected_sections()
    #: GET /api/app/config 的脱敏键（整值替换）。配置读取走
    #: ``check_app_permission``（debug 或 admin 即放行）——dev compose 默认
    #: debug=true，原实现把 ``security.secret_key`` 明文返回 = 任意登录用户
    #: 可伪造 admin token。前端可编辑节（server/gunicorn/cors/database）
    #: 不含这些键，脱敏值不会被回写。
    SENSITIVE_CONFIG_KEYS = {
        "secret_key", "secret", "client_secret", "api_key", "access_key",
        "password", "token", "refresh_token", "dsn",
    }
    #: 重启生效键——由 ``SECTION_META.restart_keys`` 一处派生。
    RESTART_REQUIRED_CONFIGS = restart_required_configs()

    def _check_permission(self, is_debug: bool, is_admin: bool) -> None:
        """
        检查操作权限

        Args:
            is_debug: 是否调试模式
            is_admin: 是否管理员

        Raises:
            AuthorizationException: 权限不足
        """
        if not is_debug and not is_admin:
            raise AuthorizationException(
                detail="该操作需要调试模式或管理员权限"
            , error_code="config_debug_or_admin_required")

    def get_config(self, section: Optional[str] = None) -> Dict[str, Any]:
        """
        获取应用配置（敏感字段脱敏）

        Args:
            section: 配置节名称，为None则返回全部配置

        Returns:
            Dict[str, Any]: 配置数据
        """
        config = get_core_config()
        config_dict = self._mask_sensitive(config.model_dump())

        if section:
            return config_dict.get(section, {})
        return config_dict

    @classmethod
    def _mask_sensitive(
        cls, data: Any, section: Optional[str] = None, key: Optional[str] = None
    ) -> Any:
        """递归脱敏：键名命中 ``SENSITIVE_CONFIG_KEYS`` 的字符串整值替换为 ``***``；

        ``database.url`` 仅掩掉凭据段（``://user:pw@`` → ``://***@``），
        保留主机/库名供运维辨识——该字段前端只读、后端拒绝修改，不会回写。
        """
        if isinstance(data, dict):
            return {
                k: cls._mask_sensitive(
                    v, section=section if section is not None else k, key=k
                )
                for k, v in data.items()
            }
        if isinstance(data, str) and data:
            if key and key.lower() in cls.SENSITIVE_CONFIG_KEYS:
                return MASK_PLACEHOLDER
            if section == "database" and key == "url":
                return _URL_CREDENTIALS_RE.sub(r"\1" + MASK_PLACEHOLDER + "@", data)
        return data

    def update_config(
        self,
        config_data: Dict[str, Any],
        is_debug: bool = False,
        is_admin: bool = False,
        updated_by: Optional[Any] = None,
    ) -> Tuple[bool, List[str], List[str]]:
        """
        更新应用配置（写入 ``app_config`` 表，随后本进程立即生效）

        Args:
            config_data: 新的配置数据
            is_debug: 是否调试模式
            is_admin: 是否管理员
            updated_by: 可选——操作者 id，落 ``app_config.updated_by``（审计）

        Returns:
            Tuple[bool, List[str], List[str]]: (是否成功, 错误信息列表, 重启提示列表)

        Raises:
            AuthorizationException: 权限不足
            ValidationException: 配置验证失败 / 提交引导层键 / 持久化失败
        """
        self._check_permission(is_debug, is_admin)

        is_valid, errors = self._validate_config_data(config_data)
        if not is_valid:
            raise ValidationException(detail=f"配置验证失败: {'; '.join(errors)}", error_code="config_validation_failed")

        restart_required, restart_items = self._check_restart_required(config_data)

        config_manager = ConfigManager()
        try:
            # ConfigManager 先持久化、成功后再改内存：写失败时运行态不变
            config_manager.update_config(config_data, updated_by=updated_by)
        except ValueError as e:
            raise ValidationException(
                detail=str(e), error_code="config_bootstrap_readonly"
            ) from e
        except ConfigWriteError as e:
            raise ValidationException(
                detail=str(e), error_code="config_persist_failed"
            ) from e

        restart_hints = []
        if restart_required:
            restart_hints.append(f"以下配置项修改后需要重启服务才能生效: {', '.join(restart_items)}")

        return True, [], restart_hints

    def get_sources(self) -> Dict[str, Dict[str, str]]:
        """各配置键的来源（``env`` / ``db`` / ``default``）——GET 的 ``meta.sources``。

        读取失败返回空 dict（meta 可选，不影响主数据）。
        """
        from app.services.config_store import section_sources

        try:
            return section_sources()
        except Exception:  # noqa: BLE001 — meta 是增强信息，绝不阻断读配置
            return {}

    def reset_config(self, is_debug: bool = False, is_admin: bool = False) -> Tuple[bool, List[str]]:
        """
        重置配置为默认值

        Args:
            is_debug: 是否调试模式
            is_admin: 是否管理员

        Returns:
            Tuple[bool, List[str]]: (是否成功, 错误信息列表)

        Raises:
            AuthorizationException: 权限不足
        """
        self._check_permission(is_debug, is_admin)

        from app.services.config_store import reset_to_seed

        # 重置 = 把种子（config.example.toml 过滤后的键）覆盖回 app_config；
        # 引导层键由 config_store 拒绝写入，模板缺失/DB 写失败均返回错误列表
        try:
            result = reset_to_seed()
        except Exception as e:  # noqa: BLE001 — DB 不可达、表未建等
            return False, [f"重置配置失败: {str(e)}"]
        if result.get("skipped"):
            return False, [f"无法重置配置（{result['skipped']}）"]

        ConfigManager().reload()
        return True, []

    def set_debug_mode(self, enabled: bool, is_admin: bool = False) -> Dict[str, Any]:
        """
        开启/关闭调试模式（写入 ``app_config`` 的 ``app.debug``）

        写库成功后本进程立即 reload，其余进程经 ``ConfigManager`` 的版本检测
        （≤ ``VERSION_CHECK_INTERVAL`` 秒）收敛——**无需重启服务**。

        Args:
            enabled: 是否开启调试模式
            is_admin: 调用者是否为管理员（仅管理员可切换）

        Returns:
            Dict: {success, debug, restart_required, message}
        """
        if not is_admin:
            raise AuthorizationException(
                detail="该操作需要管理员权限", error_code="config_admin_required"
            )

        from app.services.config_store import update_sections

        try:
            update_sections({"app": {"debug": bool(enabled)}})
        except Exception as e:  # noqa: BLE001 — DB 写失败返回失败信封，不抛
            return {
                "success": False, "debug": None, "restart_required": True,
                "message": f"写入配置失败: {e}",
            }

        ConfigManager().reload()
        state = "开启" if enabled else "关闭"
        return {
            "success": True,
            "debug": bool(enabled),
            "restart_required": False,
            "message": f"调试模式已{state}，各进程最迟 5 秒内生效",
        }

    def validate_config(self, config_data: Optional[Dict[str, Any]] = None) -> Tuple[bool, List[str]]:
        """
        验证配置数据

        Args:
            config_data: 要验证的配置数据，为None则验证当前配置

        Returns:
            Tuple[bool, List[str]]: (是否有效, 错误信息列表)
        """
        if config_data is None:
            config_data = self.get_config()

        return self._validate_config_data(config_data)

    def _check_restart_required(self, config_data: Dict[str, Any]) -> Tuple[bool, List[str]]:
        """
        检查配置修改是否需要重启才能生效

        Args:
            config_data: 新的配置数据

        Returns:
            Tuple[bool, List[str]]: (是否需要重启, 需要重启的配置项列表)
        """
        restart_items = []

        for section, fields in config_data.items():
            if section not in self.RESTART_REQUIRED_CONFIGS:
                continue
            if not isinstance(fields, dict):
                continue

            for field in fields.keys():
                if field in self.RESTART_REQUIRED_CONFIGS[section]:
                    restart_items.append(f"{section}.{field}")

        return len(restart_items) > 0, restart_items

    def _validate_config_data(self, config_data: Dict[str, Any]) -> Tuple[bool, List[str]]:
        """
        验证配置数据的内部方法

        Args:
            config_data: 配置数据

        Returns:
            Tuple[bool, List[str]]: (是否有效, 错误信息列表)
        """
        errors = []

        # 逐节校验：节可写 + 节内 ``protected_keys`` /
        # ``bootstrap_excluded_keys`` 逐键拒写。错误文案与旧实现对齐：
        #   - 不在 SECTION_META 的节 → ``未知的配置节``（原 ALLOWED 分支）；
        #   - 已知但 writable=False 的节 → ``不允许修改``（原 PROTECTED 分支）；
        #   - 节内保护键 → 键级错误（原 ``server.reload`` / ``database.url``
        #     手写检查收敛至此，文案逐键保留）。
        for section, fields in config_data.items():
            meta = SECTION_META.get(section)
            if meta is None:
                errors.append(f"未知的配置节: {section}")
                continue
            if not meta.writable:
                errors.append(f"配置节 '{section}' 不允许修改")
                continue
            if not isinstance(fields, dict):
                continue
            for field in fields:
                if field in meta.protected_keys:
                    errors.append(self._protected_field_error(section, field))
                elif field in meta.bootstrap_excluded_keys:
                    errors.append(f"{section}.{field} 不允许修改（通过环境变量注入）")

        if not any(section in self.ALLOWED_CONFIG_SECTIONS for section in config_data.keys()):
            errors.append("没有可修改的有效配置节")

        if "server" in config_data:
            errors.extend(self._validate_server_config(config_data["server"]))

        if "gunicorn" in config_data:
            errors.extend(self._validate_gunicorn_config(config_data["gunicorn"]))

        if "cors" in config_data:
            errors.extend(self._validate_cors_config(config_data["cors"]))

        if "database" in config_data:
            errors.extend(self._validate_database_config(config_data["database"]))

        # 写回校验与加载校验**同源**——各节 pydantic 模型 model_validate。
        # 原手写校验宽于启动校验（如 gunicorn.timeout=5 只查 >=0，而模型要求
        # 10~300），让非法值能经 API 写入并把应用写成重启即 crash loop。模型
        # 校验同时拦住未知键（extra=forbid），与配置源的字段过滤同规则。
        errors.extend(self._validate_sections_pydantic(config_data))

        return len(errors) == 0, errors

    @staticmethod
    def _protected_field_error(section: str, field: str) -> str:
        """受保护键的拒绝文案（逐键保留旧手写校验的口径）。

        ``server.reload`` 保留原文案；其余保护键（``storage.repo_root`` /
        ``storage.upload_root`` 等）给出受保护说明——均不进 ``config_store``
        （那里还有引导层防线二）。
        """
        if section == "server" and field == "reload":
            return "server.reload 不允许修改（运行时热重载设置）"
        return f"{section}.{field} 不允许修改（受保护配置）"

    def _validate_sections_pydantic(self, config_data: Dict[str, Any]) -> List[str]:
        """用各配置节的 pydantic 模型校验（与启动加载同一校验源）

        以当前生效配置为底、叠加本次提交（与 ``ConfigManager.update_config``
        的合并语义一致）后 ``model_validate``。无 pydantic 模型的节（如
        ``system``）跳过，由各手写校验兜底。
        """
        from pydantic import ValidationError

        errors: List[str] = []
        try:
            current_cfg = get_core_config()
        except Exception:  # noqa: BLE001 — 配置不可用时退回手写校验口径
            return errors

        for section, data in config_data.items():
            if section not in self.ALLOWED_CONFIG_SECTIONS or not isinstance(data, dict):
                continue
            sub_model = getattr(current_cfg, section, None)
            if sub_model is None or not hasattr(type(sub_model), "model_validate"):
                continue
            merged = _deep_merge_dicts(sub_model.model_dump(), data)
            try:
                type(sub_model).model_validate(merged)
            except ValidationError as exc:
                for err in exc.errors():
                    loc = ".".join(str(p) for p in err.get("loc", ()))
                    errors.append(
                        f"{section}.{loc}: {err.get('msg')}" if loc else f"{section}: {err.get('msg')}"
                    )
        return errors

    def _validate_server_config(self, server: Any) -> List[str]:
        """验证服务器配置"""
        errors = []
        if not isinstance(server, dict):
            errors.append("server 配置必须是对象")
            return errors

        if "host" in server:
            host = server["host"]
            if not isinstance(host, str) or not host:
                errors.append("服务器地址不能为空")

        if "port" in server:
            try:
                port = int(server["port"])
                if port < 1 or port > 65535:
                    errors.append("服务器端口必须是1-65535之间的整数")
            except (ValueError, TypeError):
                errors.append("服务器端口必须是1-65535之间的整数")

        if "workers" in server:
            try:
                workers = int(server["workers"])
                if workers < 1:
                    errors.append("服务器工作进程数必须是正整数")
            except (ValueError, TypeError):
                errors.append("服务器工作进程数必须是正整数")

        if "log_level" in server:
            valid_levels = {"debug", "info", "warning", "error", "critical"}
            if server["log_level"] not in valid_levels:
                errors.append(f"日志级别必须是以下之一: {', '.join(valid_levels)}")

        return errors

    def _validate_gunicorn_config(self, gunicorn: Any) -> List[str]:
        """验证 Gunicorn 配置"""
        errors = []
        if not isinstance(gunicorn, dict):
            errors.append("gunicorn 配置必须是对象")
            return errors

        int_fields = ["workers", "threads", "worker_connections", "backlog", "timeout",
                      "graceful_timeout", "keepalive", "max_requests", "max_requests_jitter"]
        for field in int_fields:
            if field in gunicorn:
                try:
                    value = int(gunicorn[field])
                    if value < 0:
                        errors.append(f"gunicorn.{field} 必须是非负整数")
                except (ValueError, TypeError):
                    errors.append(f"gunicorn.{field} 必须是整数")

        bool_fields = ["preload_app", "daemon", "access_log", "capture_output", "enable_reuse_port"]
        for field in bool_fields:
            if field in gunicorn and not isinstance(gunicorn[field], bool):
                errors.append(f"gunicorn.{field} 必须是布尔值")

        return errors

    def _validate_cors_config(self, cors: Any) -> List[str]:
        """验证 CORS 配置"""
        errors = []
        if not isinstance(cors, dict):
            errors.append("cors 配置必须是对象")
            return errors

        if "allow_origins" in cors:
            origins = cors["allow_origins"]
            if not isinstance(origins, list):
                errors.append("cors.allow_origins 必须是数组")
            elif not all(isinstance(o, str) for o in origins):
                errors.append("cors.allow_origins 中的所有元素必须是字符串")

        if "allow_methods" in cors:
            methods = cors["allow_methods"]
            if not isinstance(methods, list):
                errors.append("cors.allow_methods 必须是数组")
            elif not all(isinstance(m, str) for m in methods):
                errors.append("cors.allow_methods 中的所有元素必须是字符串")

        if "allow_headers" in cors:
            headers = cors["allow_headers"]
            if not isinstance(headers, list):
                errors.append("cors.allow_headers 必须是数组")
            elif not all(isinstance(h, str) for h in headers):
                errors.append("cors.allow_headers 中的所有元素必须是字符串")

        if "allow_credentials" in cors and not isinstance(cors["allow_credentials"], bool):
            errors.append("cors.allow_credentials 必须是布尔值")

        if "max_age" in cors:
            try:
                max_age = int(cors["max_age"])
                if max_age < 0:
                    errors.append("cors.max_age 必须是非负整数")
            except (ValueError, TypeError):
                errors.append("cors.max_age 必须是整数")

        return errors

    def _validate_database_config(self, database: Any) -> List[str]:
        """验证数据库配置"""
        errors = []
        if not isinstance(database, dict):
            errors.append("database 配置必须是对象")
            return errors

        int_fields = ["pool_size", "max_overflow", "pool_timeout", "pool_recycle",
                      "pg_connect_timeout"]
        for field in int_fields:
            if field in database:
                try:
                    value = int(database[field])
                    if value < 0:
                        errors.append(f"database.{field} 必须是非负整数")
                except (ValueError, TypeError):
                    errors.append(f"database.{field} 必须是整数")

        bool_fields = ["echo"]
        for field in bool_fields:
            if field in database and not isinstance(database[field], bool):
                errors.append(f"database.{field} 必须是布尔值")

        return errors


# 全局配置服务实例
_config_service_instance: Optional[ConfigService] = None


def get_config_service() -> ConfigService:
    """
    获取全局配置服务实例

    Returns:
        ConfigService: 配置服务实例
    """
    global _config_service_instance
    if _config_service_instance is None:
        _config_service_instance = ConfigService()
    return _config_service_instance
