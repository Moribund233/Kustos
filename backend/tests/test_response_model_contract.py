"""控制器响应契约棘轮。

规则
----
``app/api/v1/*_controller.py`` 的每条 HTTP 路由都应声明 ``response_model``。
没有声明时 OpenAPI 只能生成 ``unknown`` 响应体，前端 ``pnpm api:generate``
拿到的类型就退化为 ``unknown``，调用方只能手写类型兜底。

存量按模块计数冻结在 :data:`_UNTYPED_BASELINE`：只降不升。新控制器默认必须
全量声明；给存量模块加路由时必须顺带补 ``response_model``，否则断言变红。

例外
----
``@router.api_route(..., include_in_schema=False)`` 是内部协议端点（Git 认证
子请求），不进入 OpenAPI，天然无需响应模型，扫描时不计入。
"""

import ast
import pathlib

APP_DIR = pathlib.Path(__file__).resolve().parents[1] / "app"
API_DIR = APP_DIR / "api" / "v1"

#: 计入契约的 HTTP 方法装饰器（``api_route`` 不在其列，见模块 docstring）
_HTTP_METHODS = {"get", "post", "put", "patch", "delete"}

#: 模块 → 未声明 ``response_model`` 的路由数（存量冻结，只降不升）
_UNTYPED_BASELINE: dict = {
    "activity_controller.py": 1,
    "agent_admin_controller.py": 7,
    "agent_controller.py": 7,
    "app_controller.py": 5,
    "auth_controller.py": 3,
    "branch_controller.py": 10,
    "build_controller.py": 5,
    "chat_controller.py": 8,
    "collab_internal_controller.py": 3,
    "collab_invite_controller.py": 2,
    "collab_session_controller.py": 2,
    "commit_controller.py": 9,
    "dm_controller.py": 2,
    "file_comment_controller.py": 4,
    "fork_controller.py": 4,
    "git_hook_controller.py": 2,
    "issue_controller.py": 17,
    "key_controller.py": 1,
    "label_controller.py": 6,
    "lfs_controller.py": 6,
    "notification_controller.py": 8,
    "oauth_controller.py": 4,
    "pr_label_controller.py": 7,
    "pull_request_controller.py": 17,
    "release_controller.py": 10,
    "repository_browser_controller.py": 13,
    "repository_controller.py": 11,
    "repository_member_controller.py": 9,
    "room_controller.py": 10,
    "search_admin_controller.py": 3,
    "search_controller.py": 7,
    "star_controller.py": 4,
    "stats_controller.py": 1,
    "tag_controller.py": 4,
    "user_controller.py": 16,
    "watch_controller.py": 4,
    "webhook_controller.py": 8,
}


def _is_route_decorator(node: ast.AST) -> bool:
    """是否为 ``@<router>.<method>(...)`` 形式的 HTTP 路由装饰器。"""
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in _HTTP_METHODS
    )


def _declares_response_model(node: ast.AST, decorator: ast.Call) -> bool:
    """是否声明了响应契约。

    两条等价路径：装饰器上的 ``response_model=``，或函数返回类型注解
    （``-> list[DeviceInfo]`` / ``-> None``）——后者同样是 OpenAPI 的
    契约来源，``-> None`` 对 204 路由尤其准确。
    """
    if any(keyword.arg == "response_model" for keyword in decorator.keywords):
        return True
    returns = getattr(node, "returns", None)
    return returns is not None


def _untyped_routes(path: pathlib.Path) -> list:
    """返回文件里缺少响应契约的路由函数名列表。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out = []
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if _is_route_decorator(decorator) and not _declares_response_model(
                node, decorator
            ):
                out.append(node.name)
    return out


def test_untyped_routes_do_not_grow():
    """每条路由都应声明 response_model；存量按模块冻结。"""
    violations = []
    for path in sorted(API_DIR.glob("*_controller.py")):
        untyped = _untyped_routes(path)
        allowed = _UNTYPED_BASELINE.get(path.name, 0)
        if len(untyped) > allowed:
            violations.append(
                f"  {path.name}: {len(untyped)} 条未声明 response_model"
                f"（基线 {allowed}）: {', '.join(untyped)}"
            )
    assert (
        not violations
    ), "新增路由缺少 response_model（OpenAPI 会生成 unknown 响应体）：\n" + "\n".join(
        violations
    )


def test_baseline_files_still_exist():
    """基线里登记的文件必须仍然存在，避免改名后留下失效条目。"""
    actual = {path.name for path in API_DIR.glob("*_controller.py")}
    stale = sorted(set(_UNTYPED_BASELINE) - actual)
    assert not stale, f"基线中的控制器已不存在: {stale}"
