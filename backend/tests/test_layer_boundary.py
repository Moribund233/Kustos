"""
分层边界防回潮。

规则
----
``app/`` 下每个模块归属一个**层**，层与层之间只允许**单向向下**依赖。
白名单显式列在 :data:`LAYER_RULES` 里——不写「隐式约定」，写死可审的规则表。

层的次序（由上至下）::

    api  →  services  →  middleware  →  core  →  models  →  utils

其中 ``core`` 与 ``models`` 允许互相引用（策略函数需要读实体、实体的默认值
需要读常量），二者合起来算「下层」。

检查点
------
1. **跨层违规**：下层不得 import 上层。这条同时覆盖**模块级**和**函数体内**
   的 import——后者最容易被当成「合法的延迟导入」而溜过去。
2. **延迟导入棘轮**：全仓函数体内的 import 总数不得超过 :data:`_DEFERRED_BASELINE`。
   棘轮只收不放：修掉一批就把基线调低，让它无法悄悄反弹。

相对导入（``from . import x`` / ``from ..core import y``）按所在包解析成
绝对模块后再判定，避免「换个写法就绕过检查」。
"""
import ast
import pathlib

APP_DIR = pathlib.Path(__file__).resolve().parents[1] / "app"

#: 层 → 允许依赖的层集合。白名单式：新增层必须在这里显式登记。
LAYER_RULES: dict = {
    "utils": {"utils", "core", "models"},
    "models": {"models", "core", "utils"},
    "core": {"core", "models", "utils"},
    "middleware": {"middleware", "core", "models", "utils"},
    "services": {"services", "core", "models", "utils", "middleware"},
    "api": {"api", "core", "models", "utils", "services", "middleware"},
}

#: ``app/`` 根目录模块（main.py / lifespan.py 等）位于装配层，可依赖任意层。
ROOT_LAYER = "root"

#: 全仓函数体内 import 的数量上限（棘轮）。每清理一批就下调。
#: 2026-10-30：479 → 474（清理 config.toml 参数链 + 控制器 SQL 下沉时提升的模块级导入）。
#: 同日 474 → 477：新增协作草稿发布控制器 collab_publish_controller 的路由注册与
#: ensure_local_write 分支保护接线（沿用既有模式，无新增跨层依赖）。
#: 2026-11-06：477 → 478：新增协作感知控制器 collab_active_controller 的路由注册，
#: 与上一条同为 create_api_router 内的既有注册模式（无新增跨层依赖）。
#: 同日 478 → 479：保留任务接入幂等记录清理，沿用 run_once 内已有的
#: "缺省会话时自建 get_async_db_context" 分支模式（与其他四类保留同构）。
#: 同日 479 → 480：新增 PKCE 授权码控制器的路由注册，同 create_api_router 既有模式。
#: 同日 480 → 481：PKCE 授权码清理并入保留任务，与幂等记录同构
#: （缺省会话时自建 get_async_db_context）。
_DEFERRED_BASELINE = 481


def _layer_of(path: pathlib.Path) -> str:
    """返回文件所属的层名；``app/`` 根目录下的文件归入 :data:`ROOT_LAYER`。"""
    rel = path.relative_to(APP_DIR)
    return rel.parts[0] if len(rel.parts) > 1 else ROOT_LAYER


def _package_of(path: pathlib.Path) -> str:
    """返回文件所属的绝对包名（不含模块名本身）。"""
    rel = path.relative_to(APP_DIR)
    parts = list(rel.parts[:-1])
    return ".".join(["app"] + parts)


def _resolve(node: ast.AST, pkg: str) -> str:
    """把 import 语句解析成绝对模块名；相对导入按所在包向上拼接。"""
    if isinstance(node, ast.ImportFrom):
        if node.level == 0:
            base = node.module or ""
        else:
            # level=1 → 当前包；level=2 → 父包……
            parts = pkg.split(".")
            if node.level - 1 > len(parts):
                return ""
            base = ".".join(parts[: len(parts) - (node.level - 1)])
            if node.module:
                base = f"{base}.{node.module}" if base else node.module
        return base
    return node.names[0].name if isinstance(node, ast.Import) and node.names else ""


def _top_layer(module: str) -> str:
    """取绝对模块名的第一段层名（``app.xxx`` → ``xxx``）。"""
    parts = module.split(".")
    if parts and parts[0] == "app":
        parts = parts[1:]
    return parts[0] if parts else ""


def _iter_imports(tree: ast.AST):
    """遍历所有 import 语句（模块级与函数体内一并覆盖）。"""
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            yield node


def _imported_modules(node: ast.AST) -> list:
    if isinstance(node, ast.Import):
        return [alias.name for alias in node.names]
    if isinstance(node, ast.ImportFrom):
        if node.module:
            return [node.module]
        # `from . import x` —— 名字在 node.names 里，模块是当前包
        return []
    return []


def _violations() -> list:
    """扫描全部模块，返回 ``(层, 违规来源层, 文件:行)`` 三元组列表。"""
    out = []
    for path in sorted(APP_DIR.rglob("*.py")):
        layer = _layer_of(path)
        if layer == ROOT_LAYER:
            continue
        allowed = LAYER_RULES.get(layer)
        if allowed is None:
            out.append((layer, "未登记的层", f"{path.relative_to(APP_DIR).as_posix()}:0"))
            continue
        pkg = _package_of(path)
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in _iter_imports(tree):
            if isinstance(node, ast.ImportFrom) and node.level:
                base = _resolve(node, pkg)
                if not base:
                    continue
                top = _top_layer(base)
                if top in LAYER_RULES and top not in allowed:
                    out.append(
                        (layer, top, f"{path.relative_to(APP_DIR).as_posix()}:{node.lineno}")
                    )
                continue
            for module in _imported_modules(node):
                top = _top_layer(module)
                if top in LAYER_RULES and top not in allowed:
                    out.append(
                        (layer, top, f"{path.relative_to(APP_DIR).as_posix()}:{node.lineno}")
                    )
    return out


def _deferred_import_count() -> int:
    """统计函数体（含嵌套函数）内的 import 语句数量。"""
    total = 0
    for path in sorted(APP_DIR.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for sub in ast.walk(node):
                    if isinstance(sub, (ast.Import, ast.ImportFrom)):
                        total += 1
    return total


def test_no_cross_layer_imports():
    """下层不得 import 上层（含函数体内的延迟导入）。"""
    violations = _violations()
    if violations:
        detail = "\n".join(
            f"  {src_layer} → {dst_layer}  ({where})" for src_layer, dst_layer, where in violations
        )
        raise AssertionError(
            f"检测到 {len(violations)} 处跨层依赖（层依赖表见 LAYER_RULES）：\n{detail}"
        )


def test_all_layers_registered():
    """app/ 下出现的每个一级目录都必须在 LAYER_RULES 中登记。"""
    actual = {
        p.relative_to(APP_DIR).parts[0]
        for p in APP_DIR.iterdir()
        if p.is_dir() and (p / "__init__.py").exists()
    }
    unregistered = actual - set(LAYER_RULES)
    assert not unregistered, f"未在 LAYER_RULES 登记的层: {sorted(unregistered)}"


def test_deferred_imports_do_not_grow():
    """延迟导入棘轮：函数体内的 import 不得增加。"""
    total = _deferred_import_count()
    assert total <= _DEFERRED_BASELINE, (
        f"函数体内 import 数量上升到 {total}（基线 {_DEFERRED_BASELINE}）。"
        "新增延迟导入前请先确认它不违反分层；"
        "若确实清理了一批旧债，请同步下调 _DEFERRED_BASELINE。"
    )


def test_controllers_do_not_import_each_other():
    """控制器之间不得互相 import。

    控制器是平级的：共享逻辑要么下沉到 ``api/guards.py``（FastAPI 依赖接线），
    要么属于领域逻辑、下沉到 ``services/``。互相 import 会让「拆一个控制器」
    变成跨文件手术，并让 ``api/v1`` 内部形成隐形依赖图。
    """
    violations = []
    for path in sorted((APP_DIR / "api" / "v1").glob("*_controller.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in _iter_imports(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                if node.module.startswith("app.api.v1.") and node.module.endswith(
                    "_controller"
                ):
                    violations.append(
                        f"{path.name}:{node.lineno} → {node.module}"
                    )
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.startswith(
                        "app.api.v1."
                    ) and alias.name.endswith("_controller"):
                        violations.append(
                            f"{path.name}:{node.lineno} → {alias.name}"
                        )
    assert not violations, (
        "控制器之间出现互相 import（共享逻辑应下沉到 guards 或 services）：\n  "
        + "\n  ".join(violations)
    )


def test_models_package_does_not_hold_a_sync_engine():
    """``models`` 包只声明 Base 与导入模型——不得再持有同步引擎。

    应用的运行时引擎是**异步**的（:mod:`app.models.async_db`）。同步驱动只允许
    出现在 Alembic 迁移工具链与一次性运维动作里；一旦在包入口重新长出
    ``create_engine`` / ``SessionLocal``，就等于复活了「同步/异步双引擎」，
    连接池会变成两套并行状态。
    """
    forbidden = {
        "create_engine",
        "sessionmaker",
        "SessionLocal",
        "init_engine",
        "get_engine",
    }
    src = (APP_DIR / "models" / "__init__.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name in forbidden:
                    hits.append(f"from {node.module} import {alias.name}")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[-1] in forbidden:
                    hits.append(f"import {alias.name}")
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in forbidden:
                    hits.append(f"赋值 {target.id}")
    assert not hits, (
        "models/__init__.py 不应再持有同步引擎：" + "、".join(hits)
    )
