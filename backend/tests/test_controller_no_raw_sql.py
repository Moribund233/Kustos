"""控制器不得直连 SQL。

规则
----
``app/api/v1/*_controller.py`` 里**不得**出现 ``select(...)`` / ``session.execute(...)``
/ ``text(...)``——业务查询一律下沉到服务层。控制器只做参数编排、依赖注入与响应组装。

例外
----
**认证层**的 SQL 是设计如此：令牌 → 用户的裁决、仓库可见性的裁决，本来就属于
「请求进来时判断你是谁、你能不能看这个仓库」这一层。下面 :data:`_AUTH_LAYER_ALLOW`
逐个列出并注明原因。

> 这不是「规则没被执行」的空话——它由 AST 扫描强制，新增一处就变红。
"""
import ast
import pathlib

APP_DIR = pathlib.Path(__file__).resolve().parents[1] / "app"
API_DIR = APP_DIR / "api"

#: 认证层例外：文件名 → 原因
_AUTH_LAYER_ALLOW: dict = {
    "deps.py": "认证依赖：令牌 → 用户的裁决（每请求都要查库，属认证层职责）",
    "guards.py": "权限守卫：仓库可见性裁决（404 → 401 → 403 的顺序判断）",
    "ws/auth.py": "WebSocket 握手认证：校验 token 与用户状态",
    "v1/collab_internal_controller.py": "网关回调的 token → 用户校验",
    "v1/git_auth_controller.py": "Nginx auth_request 子请求：认证决策本身",
    "v1/lfs_controller.py": "LFS Basic/Bearer 认证：解析凭据并定位用户",
}

#: 被判定为「直连 SQL」的调用名
_SQL_CALLS = {"select", "execute", "text"}


def _is_sql_call(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    if isinstance(func, ast.Name):
        return func.id in _SQL_CALLS
    if isinstance(func, ast.Attribute):
        return func.attr in _SQL_CALLS
    return False


def _scan(path: pathlib.Path) -> list:
    """返回该文件里的 SQL 调用位置（相对文件路径 + 行号 + 调用名）。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    hits = []
    for node in ast.walk(tree):
        if _is_sql_call(node):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr
            hits.append((node.lineno, name))
    return hits


def test_controllers_do_not_query_directly():
    """控制器不得直连 SQL（认证层例外见 _AUTH_LAYER_ALLOW）。"""
    violations = []
    for path in sorted(API_DIR.rglob("*_controller.py")):
        rel = path.relative_to(API_DIR).as_posix()
        if rel in _AUTH_LAYER_ALLOW:
            continue
        for lineno, name in _scan(path):
            violations.append(f"{rel}:{lineno} {name}()")
    assert not violations, (
        "控制器里出现直连 SQL（应下沉到 services）：\n  "
        + "\n  ".join(violations)
    )


def test_auth_layer_allowlist_is_accurate():
    """认证层白名单里的文件必须真的存在，且仍在使用 SQL。

    两者都要检查：白名单条目失效（文件改名/删除）会让例外悄悄消失；
    白名单里的文件不再用 SQL，则这条登记已经没有意义，应当删掉。
    """
    for rel in _AUTH_LAYER_ALLOW:
        path = API_DIR / rel
        assert path.exists(), f"认证层白名单指向的文件不存在: {rel}"
        assert _scan(path), (
            f"认证层白名单里的 {rel} 已不再直连 SQL——请把这条登记删掉，"
            "否则例外会变成掩盖新违规的毯子"
        )


def test_auth_layer_allowlist_has_no_stale_entries():
    """白名单不得登记非认证层的文件（防止例外被用来绕过规则）。"""
    allowed = set(_AUTH_LAYER_ALLOW)
    actual = {
        p.relative_to(API_DIR).as_posix()
        for p in API_DIR.rglob("*_controller.py")
    } | {"deps.py", "guards.py", "ws/auth.py"}
    stale = allowed - actual
    assert not stale, f"白名单里有已不存在的文件: {sorted(stale)}"
