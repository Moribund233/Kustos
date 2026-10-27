"""
事件循环阻塞防回潮。

规则
----
`services/**/*.py` 的 **async 函数体**内不得**直接**调用阻塞实现：

- ``utils/git_utils`` 的顶层同步函数（会阻塞事件循环）；
- ``pygit2.*``（本地仓库 I/O，同样阻塞）。

允许的写法是下沉到线程池：``await asyncio.to_thread(fn, ...)`` 或
``@offload_to_thread`` 装饰的 **同步** 函数。以下情形**不算**违规：

- 调用发生在同步函数体内（``def`` / 嵌套 ``def`` / ``lambda``）——它们本就
  应由 ``to_thread`` 承载；
- 调用是 ``to_thread(...)`` 的实参（``asyncio.to_thread(get_local_branch_heads, p)``
  传的是名字而非调用）；
- ``git_utils`` 中的纯计算 / 无 I/O 辅助（``PURE`` 集合）。

若确有必须的例外，加入 ``_ALLOWLIST`` 并注明原因——其余任何新增都会让本测试
变红，从而拦住「顺手在 async 里直接调 pygit2」的回潮。
"""
import ast
import pathlib

APP_DIR = pathlib.Path(__file__).resolve().parents[1] / "app"
GIT_UTILS = APP_DIR / "utils" / "git_utils.py"
SERVICES_DIR = APP_DIR / "services"

#: git_utils 中无 I/O / 极轻量、允许在 async 体内直接调用的辅助
PURE = {
    "get_repository_storage_path",
    "create_signature",
    "repo_exists",
}

#: 已知、经确认必须在 async 体内直接阻塞调用的例外（file, func, call）→ 原因。
#: 保持为空：零例外是最好的状态；新增例外需在评审中说明。
_ALLOWLIST: set = set()


def _git_utils_blocking_names() -> set:
    tree = ast.parse(GIT_UTILS.read_text(encoding="utf-8"))
    names = set()
    for node in tree.body:
        # 只收顶层同步函数；async 目标本就该被 await，不在阻塞之列
        if isinstance(node, ast.FunctionDef) and not node.name.startswith("_"):
            names.add(node.name)
    return names - PURE


def _call_display(node: ast.Call) -> str:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if (
        isinstance(func, ast.Attribute)
        and isinstance(func.value, ast.Name)
        and func.value.id == "pygit2"
    ):
        return f"pygit2.{func.attr}"
    return ""


class _AsyncBlockingVisitor(ast.NodeVisitor):
    """在 async 函数体内、且不在同步嵌套函数 / to_thread 实参中的阻塞调用。"""

    def __init__(self, blocking_names: set, module: str):
        self._blocking = blocking_names
        self._module = module
        self._async_depth = 0
        self._sync_def_depth = 0
        self._to_thread_depth = 0
        self.violations = []  # (module, lineno, name)

    # -- 作用域跟踪 ---------------------------------------------------------
    def visit_AsyncFunctionDef(self, node):
        self._async_depth += 1
        self._sync_def_depth += 1  # 进入任意函数体即离开调用者作用域
        self.generic_visit(node)
        self._sync_def_depth -= 1
        self._async_depth -= 1

    def visit_FunctionDef(self, node):
        self._sync_def_depth += 1
        self.generic_visit(node)
        self._sync_def_depth -= 1

    def visit_Lambda(self, node):
        self._sync_def_depth += 1
        self.generic_visit(node)
        self._sync_def_depth -= 1

    def visit_Call(self, node):
        func = node.func
        is_to_thread = (
            (isinstance(func, ast.Name) and func.id == "to_thread")
            or (isinstance(func, ast.Attribute) and func.attr == "to_thread")
        )
        if is_to_thread:
            self._to_thread_depth += 1
            self.generic_visit(node)
            self._to_thread_depth -= 1
            return

        name = _call_display(node)
        if (
            self._async_depth > 0
            and self._sync_def_depth == 0
            and self._to_thread_depth == 0
        ):
            if name in self._blocking or name.startswith("pygit2."):
                self.violations.append((self._module, node.lineno, name))
        self.generic_visit(node)


def _collect_violations():
    blocking = _git_utils_blocking_names()
    violations = []
    for path in sorted(SERVICES_DIR.rglob("*.py")):
        rel = path.relative_to(APP_DIR).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"))
        visitor = _AsyncBlockingVisitor(blocking, rel)
        visitor.visit(tree)
        for module, lineno, name in visitor.violations:
            if (module, name) in _ALLOWLIST:
                continue
            violations.append((module, lineno, name))
    return violations


def test_no_direct_blocking_calls_in_async_services():
    """services/ 的 async 函数体不得直接调用 git_utils 同步函数或 pygit2.*。"""
    violations = _collect_violations()
    assert violations == [], (
        "检测到事件循环阻塞回潮（应改用 await asyncio.to_thread(...) 或 "
        "@offload_to_thread 同步函数）:\n"
        + "\n".join(f"  {m}:{ln}: {name}()" for m, ln, name in violations)
    )


def test_scan_actually_covers_services():
    """金丝雀：确保扫描到了 services 下的文件与 git_utils 阻塞名单非空，
    避免路径写错导致测试空跑（假绿）。"""
    assert SERVICES_DIR.is_dir()
    assert list(SERVICES_DIR.rglob("*.py")), "services/ 下未发现 .py 文件"
    assert _git_utils_blocking_names(), "git_utils 阻塞函数名单为空"
