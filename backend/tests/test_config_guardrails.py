"""配置防复发护栏。

四类护栏：

1. **死键覆盖**：``Config`` 每个字段必须在业务源码中有读者（或显式白名单放行）；
2. **元数据一致性**：``config_service`` / ``agent_admin_service`` / 前端只读字段
   必须与 ``SECTION_META`` 派生一致（防重新硬编码导致漂移）；
3. **模板一致性**：``config.example.toml`` 的节 ⊆ ``SECTION_META``（键 ⊆ 字段集
   已由 ``test_config_store.test_only_known_fields_are_seeded`` 覆盖）；
4. **常量扫描**：``services/`` 下新增「大小/TTL/超时/并发」类模块级数字常量必须
   是 ``get_config_value`` 的回退默认（或显式豁免），否则禁止。

匹配口径：收集 ``.字段`` 与 ``"字段"`` 两种引用；排除 ``core/config.py``
自身与 ``tests/``；扫描范围必须含 ``models/``。
"""
from __future__ import annotations

import ast
import re
import tomllib
from pathlib import Path

import pytest

from app.core.config_schema import (
    SECTION_META,
    bootstrap_excluded_keys,
    protected_sections,
    restart_required_configs,
    section_model_fields,
    writable_sections,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
APP_DIR = PROJECT_ROOT / "app"

#: 扫描目录（业务源码；含 models/ —— ``DatabaseSettings.pool_*`` 的读者在
#: ``models/__init__.py``）。controller 已并入 api/v1。
_SCAN_DIRS = ("services", "api", "utils", "middleware", "models", "core")
_SCAN_ROOT_FILES = ("main.py",)

#: 死键白名单：(节, 字段) → 放行原因。接线完成后应清零。
#: 仅放行「纯声明 / 校验 / 占位死键」——真行为读者应通过扫描而非白名单。
_DEADKEY_ALLOW: dict[tuple[str, str], str] = {
    ("lfs", "s3_access_key"): "占位死键：S3 后端未实现（lfs_controller 501），节整节不可写",
    ("lfs", "s3_bucket"): "同上（占位死键）",
    ("lfs", "s3_endpoint"): "同上（占位死键）",
    ("lfs", "s3_region"): "同上（占位死键）",
    ("lfs", "s3_secret_key"): "同上（占位死键）",
}

#: 常量扫描白名单：(文件, 常量名) → 放行原因（不走配置的固有值/协议值）。
_CONST_ALLOW: dict[tuple[str, str], str] = {
    ("services/agent_admin_service.py", "MODELS_TIMEOUT"):
        "provider 模型列表探测超时，未纳入配置范围",
    ("services/agent_admin_service.py", "PROBE_TIMEOUT"):
        "provider 探测超时，未纳入配置范围",
    ("services/audit_query_service.py", "MAX_SCAN_LINES"):
        "审计查询扫描护栏，未纳入配置范围",
    ("services/config_store.py", "_SECRET_TTL"):
        "播种/写入事务内部 TTL（配置机制自身，不读配置）",
    ("services/file_comment_service.py", "MAX_COMMENT_LENGTH"):
        "评论长度契约（API 行为值），未纳入配置范围",
    ("services/indexing/chunker.py", "MIN_REF_LEN"):
        "引用最短长度阈值（非大小/TTL/超时/并发类，扫描正则保守命中）",
    ("services/redis_admin_service.py", "_KEYSPACE_TTL_SECONDS"):
        "keyspace 事件订阅 TTL，未纳入配置范围",
    ("services/worker_registry.py", "DEFAULT_TTL_SECONDS"):
        "worker 注册表 TTL，未纳入配置范围",
}

#: 模块级数字常量名的「大小/TTL/超时/并发」类判定
_GUARDRAIL_NAME = re.compile(
    r"(^MAX_|_MAX$|_MAX_|^MIN_|_MIN$|_MIN_|SIZE|BYTES|TTL|TIMEOUT|CONCURRENT"
    r"|INTERVAL|KEEP_DAYS|_LIMIT$|LIMIT_)",
    re.IGNORECASE,
)


def _iter_py_files():
    for d in _SCAN_DIRS:
        base = APP_DIR / d
        if base.is_dir():
            yield from base.rglob("*.py")
    for name in _SCAN_ROOT_FILES:
        p = APP_DIR / name
        if p.is_file():
            yield p


def _source_text() -> str:
    parts: list[str] = []
    for path in _iter_py_files():
        rel = path.relative_to(APP_DIR).as_posix()
        if rel == "core/config.py":  # 排除配置模型自身
            continue
        try:
            parts.append(path.read_text(encoding="utf-8"))
        except UnicodeDecodeError:  # pragma: no cover — 源码目录应全为 utf-8
            continue
    return "\n".join(parts)


def _rel(path: Path) -> str:
    return path.relative_to(APP_DIR).as_posix()


# ---------------------------------------------------------------------------
# 1. 死键覆盖
# ---------------------------------------------------------------------------


class TestDeadKeyCoverage:
    def test_every_config_field_is_referenced_or_whitelisted(self):
        """每个配置字段在业务源码中必须有 ``.字段`` / ``"字段"`` 级读者。

        无读者的键即「死配置」——要么接线（消费点读 ``get_config_value``），
        要么进 ``_DEADKEY_ALLOW`` 并注释原因（纯声明/校验/占位）。
        """
        text = _source_text()
        dead: list[str] = []
        for section, fields in sorted(section_model_fields().items()):
            for field in sorted(fields):
                if (section, field) in _DEADKEY_ALLOW:
                    continue
                pat_dot = re.compile(rf"\.{re.escape(field)}\b")
                pat_lit = re.compile(rf"[\"']{re.escape(field)}[\"']")
                if not (pat_dot.search(text) or pat_lit.search(text)):
                    dead.append(f"{section}.{field}")
        assert dead == [], (
            "以下配置字段无任何业务读者（接线，或加入 _DEADKEY_ALLOW 并注释原因）:\n"
            + "\n".join(f"  {d}" for d in dead)
        )


# ---------------------------------------------------------------------------
# 2. 元数据一致性（单一声明源 = SECTION_META）
# ---------------------------------------------------------------------------


class TestMetadataSingleSource:
    def test_config_service_derives_from_section_meta(self):
        from app.services.config_service import ConfigService

        assert ConfigService.ALLOWED_CONFIG_SECTIONS == writable_sections()
        assert ConfigService.PROTECTED_CONFIG_SECTIONS == protected_sections()
        assert ConfigService.RESTART_REQUIRED_CONFIGS == restart_required_configs()

    def test_config_store_bootstrap_derives_from_section_meta(self):
        from app.core import config_store

        assert config_store.BOOTSTRAP_EXCLUDED_KEYS == bootstrap_excluded_keys()

    def test_agent_admin_meta_derives_from_section_meta(self):
        from app.services import agent_admin_service
        from app.core.config_schema import editable_key_sets

        hot, restart = editable_key_sets("agent")
        assert set(agent_admin_service.HOT_KEYS) == set(hot)
        assert set(agent_admin_service.RESTART_KEYS) == set(restart)
        # 可写全集 = 节字段全集（新增字段天然纳入）
        assert set(agent_admin_service.EDITABLE_KEYS) == set(
            section_model_fields()["agent"]
        )


# ---------------------------------------------------------------------------
# 3. 模板一致性（键 ⊆ 字段由 test_config_store 覆盖，这里补节声明）
# ---------------------------------------------------------------------------


class TestTemplateConsistency:
    def test_example_sections_declared_in_section_meta(self):
        data = tomllib.loads(
            (PROJECT_ROOT / "config.example.toml").read_text(encoding="utf-8")
        )
        undeclared = sorted(set(data) - set(SECTION_META))
        assert undeclared == [], (
            "config.example.toml 含未在 SECTION_META 声明的节: "
            f"{undeclared}（新节须先声明元数据）"
        )

    def test_example_fields_exist_on_models(self):
        """模板键 ⊆ 模型字段（与 test_config_store 同口径、双保险）。"""
        fields = section_model_fields()
        bad: list[str] = []
        data = tomllib.loads(
            (PROJECT_ROOT / "config.example.toml").read_text(encoding="utf-8")
        )
        for section, kv in data.items():
            if not isinstance(kv, dict):
                continue
            if section not in fields:
                bad.append(f"[{section}]（节无模型）")
                continue
            for key in kv:
                if key not in fields[section]:
                    bad.append(f"{section}.{key}")
        assert bad == [], f"模板键无对应模型字段: {bad}"


# ---------------------------------------------------------------------------
# 4. 常量扫描（services/ 下 guardrail 类数字常量必须走配置）
# ---------------------------------------------------------------------------


def _is_numeric(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return not isinstance(node.value, bool)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        return _is_numeric(node.operand)
    return False


def _module_level_numeric_names(tree: ast.Module) -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    for node in tree.body:
        targets: list[ast.expr] = []
        if isinstance(node, ast.Assign):
            targets = node.targets
            value = node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets = [node.target]
            value = node.value
        else:
            continue
        if not _is_numeric(value):
            continue
        for t in targets:
            if isinstance(t, ast.Name) and _GUARDRAIL_NAME.search(t.id):
                out.append((t.id, node.lineno))
    return [(n, ln) for n, ln in out]  # type: ignore[misc]


def _config_value_fallback_names(tree: ast.Module) -> set[str]:
    """同文件中作为 ``get_config_value(...)`` 回退参数出现的常量名。

    命中 = 该常量是 helper 的降级默认（配置接线的合法形态）。
    """
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        fname = getattr(func, "id", None) or getattr(func, "attr", None)
        if fname != "get_config_value" or not node.args:
            continue
        last = node.args[-1]
        if isinstance(last, ast.Name):
            names.add(last.id)
    return names


class TestConstantScan:
    def test_guardrail_constants_are_config_fallbacks(self):
        """``services/`` 下「大小/TTL/超时/并发」类模块级数字常量：

        - 允许：作为 ``get_config_value`` 的**回退默认**出现（接线形态）；
        - 允许：``_CONST_ALLOW`` 白名单（固有值/协议值，注释原因）；
        - 禁止：其余裸常量直接参与业务判断（应接线为配置）。
        """
        violations: list[str] = []
        for path in sorted(_iter_py_files()):
            rel = _rel(path)
            if not rel.startswith("services/"):
                continue
            try:
                text = path.read_text(encoding="utf-8")
                tree = ast.parse(text)
            except (SyntaxError, UnicodeDecodeError):  # pragma: no cover
                continue
            lines = text.splitlines()
            fallbacks = _config_value_fallback_names(tree)
            for name, lineno in _module_level_numeric_names(tree):
                if name in fallbacks:
                    continue
                if (rel, name) in _CONST_ALLOW:
                    continue
                # 注释豁免：行尾带 ``# config-allow: <原因>``
                line = lines[lineno - 1] if lineno <= len(lines) else ""
                if re.search(r"#\s*config-allow:\s*\S", line):
                    continue
                violations.append(f"{rel}:{lineno} {name}")
        assert violations == [], (
            "services/ 下发现未接线的 guardrail 类数字常量"
            "（接线 get_config_value / 加 _CONST_ALLOW / 行尾 # config-allow: 原因）:\n"
            + "\n".join(f"  {v}" for v in violations)
        )
