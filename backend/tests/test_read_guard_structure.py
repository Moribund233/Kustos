"""读守卫覆盖结构断言（5 个「无读守卫但有私域」router 的防回潮）

仓库域控制器有 20 个挂了 router 级 ``require_repo_read``（审查实测 ≥16 承诺数）。
剩余仓库域 router **不再加读守卫**，而是靠**逐端点授权**：

- ``repository_member_controller``：逐端点 ``ensure_repo_action(MEMBER_READ)``；
- ``webhook_controller``：逐端点 ``get_current_user`` +
  ``ensure_repo_action(REPO_ADMIN/… )``；
- ``collab_invite_controller`` / ``collab_session_controller``：逐端点
  ``get_current_user`` + host/owner 校验（两者均只含 POST，无读取面）；
- ``lfs_controller``：batch 两入口在 handler 内 ``_authenticate_batch_user`` +
  ``_ensure_lfs_action``；transfer 端点用 ``_require_lfs_transfer`` 传输令牌。

本文件把「**恰好这 5 个**」与「**每条路由都有授权**」钉成结构约束：

1. **全量自检 + 金丝雀**：凡含仓库寻址（``{repo_id}`` 或 ``/api/v1/lfs``）的
   路由所属控制器，无 router 级读守卫者**必须 == 上述 5 个**。新增仓库域控制器
   要么挂读守卫，要么显式登入这里并给出理由，否则断言直接报错。
2. **端点授权审计**：5 个 router 的每条路由都必须携带授权依赖
   （``get_current_user`` / ``get_optional_user`` / ``_require_lfs_transfer``），
   或在 handler 内完成认证（LFS batch 两入口）——不得出现无授权的匿名单端点。
"""
import inspect as _inspect

import pytest
from fastapi.routing import APIRoute


#: 恰好无 router 级读守卫的仓库域控制器（逐端点授权；改动必须连带本清单与理由）
_GOLDEN_UNGUARDED_MODULES = frozenset({
    "app.api.v1.repository_member_controller",
    "app.api.v1.webhook_controller",
    "app.api.v1.lfs_controller",
    "app.api.v1.collab_invite_controller",
    "app.api.v1.collab_session_controller",
})

#: 授权依赖标记：逐端点授权模式下，路由依赖里必须出现其一
_AUTH_MARKERS = frozenset({
    "get_current_user",
    "get_optional_user",
    # ``require_repo_read`` / ``require_repo_permission`` / ``_require_lfs_transfer``
    # 的工厂闭包统一名为 ``_dependency``，token 工厂名为 ``_require_lfs_transfer``
    "_dependency",
    "_require_lfs_transfer",
})

#: handler 内部完成认证的端点（无显式依赖参数；授权代码在函数体内）
_IN_HANDLER_AUTH_ENDPOINTS = frozenset({
    "batch",           # lfs batch（repo_id 寻址）：_run_batch 内授权
    "batch_by_path",   # lfs batch（owner/repo 寻址，网关重写入口）：同左
})


@pytest.fixture(scope="module")
def fastapi_app():
    from app.main import create_app

    application = create_app()
    application.openapi()  # 触发懒加载路由展开
    return application


def _flatten(routes, out=None):
    """递归展开 ``_IncludedRouter``，得到注册顺序的 APIRoute 列表"""
    out = [] if out is None else out
    for route in routes:
        if isinstance(route, APIRoute):
            out.append(route)
            continue
        inner = getattr(route, "original_router", None)
        children = inner.routes if inner is not None else getattr(route, "routes", None)
        if children:
            _flatten(children, out)
    return out


def _dep_callables(route):
    """收集路由携带的全部依赖可调用对象（router 级 + 端点签名 + 传递依赖）"""
    out = []
    for item in getattr(route, "dependencies", None) or ():
        call = getattr(item, "dependency", None) or getattr(item, "call", None)
        if call:
            out.append(call)
    stack = list(getattr(route.dependant, "dependencies", None) or ())
    seen = set()
    while stack:
        dep = stack.pop()
        if id(dep) in seen:
            continue
        seen.add(id(dep))
        call = getattr(dep, "call", None)
        if call:
            out.append(call)
        stack.extend(getattr(dep, "dependencies", None) or ())
    return out


def _has_read_guard(route):
    """路由是否携带 router 级读守卫依赖。

    识别法：读守卫 ``require_repo_read`` 生成的 ``_dependency(request, db,
    current_user)`` 不从参数列表读 ``repo_id``（改走 ``request.path_params``），
    与 ``require_repo_permission``（签名含 ``repo_id`` 参数）结构可区分。
    """
    for call in _dep_callables(route):
        name = getattr(call, "__name__", "")
        if name == "_dependency" and "repo_id" not in _inspect.signature(call).parameters:
            return True
    return False


def _is_repo_domain(route) -> bool:
    return "{repo_id}" in route.path or route.path.startswith("/api/v1/lfs")


def _routes_by_module(app):
    grouped = {}
    for route in _flatten(app.routes):
        grouped.setdefault(route.endpoint.__module__, []).append(route)
    return grouped


def test_unguarded_repo_modules_is_golden_five(fastapi_app):
    """全量自检：无 router 级读守卫的仓库域控制器必须恰为金丝雀 5 个"""
    grouped = _routes_by_module(fastapi_app)
    unguarded = sorted({
        mod for mod, routes in grouped.items()
        if any(_is_repo_domain(r) for r in routes)
        and not any(_has_read_guard(r) for r in routes)
    })
    want = sorted(_GOLDEN_UNGUARDED_MODULES)
    assert unguarded == want, (
        "无读守卫的仓库域控制器与金丝雀清单不一致——新增仓库域控制器要么挂"
        "router 级 require_repo_read，要么显式登入 _GOLDEN_UNGUARDED_MODULES "
        "并说明逐端点授权方案：\n"
        f"  多出（未登记）：{sorted(set(unguarded) - set(want)) or '—'}\n"
        f"  缺失（多挂了守卫）：{sorted(set(want) - set(unguarded)) or '—'}"
    )


def test_golden_five_routes_all_authenticated(fastapi_app):
    """端点授权审计：金丝雀 5 个 router 的每条路由都必须带授权"""
    grouped = _routes_by_module(fastapi_app)
    bad = []
    for mod in sorted(_GOLDEN_UNGUARDED_MODULES):
        for route in grouped.get(mod, ()):
            if route.endpoint.__name__ in _IN_HANDLER_AUTH_ENDPOINTS:
                continue  # handler 内完成认证（LFS batch），非匿名
            calls = {getattr(c, "__name__", "") for c in _dep_callables(route)}
            if not (calls & _AUTH_MARKERS):
                methods = ",".join(sorted(
                    m for m in (route.methods or {"GET"}) if m not in ("HEAD", "OPTIONS")
                )) or "GET"
                bad.append(f"  {methods:12} {route.path} ({route.endpoint.__name__})")
    assert not bad, (
        "以下路由属于「无读守卫但有私域」的 5 个 router，却没有任何授权依赖"
        "（防回潮失败，需补逐端点授权）：\n" + "\n".join(bad)
    )


def test_unguarded_routers_have_no_anonymous_get(fastapi_app, test_client, db):
    """行为锚点：金丝雀 router 对**现存私仓**的匿名访问不得返回 200"""
    from app.models.repository import Repository
    from app.models.user import User

    owner = User(
        username="guard_anchor_owner",
        email="guard_anchor_owner@example.com",
        password="x",
        is_active=True,
    )
    db.add(owner)
    db.commit()
    db.refresh(owner)
    repo = Repository(
        name="guard-anchor", path="guard-anchor", owner_id=owner.id, is_public=False
    )
    db.add(repo)
    db.commit()
    db.refresh(repo)
    rid = repo.id

    # 私仓成员列表匿名 → 401（repository_member_controller，逐端点授权）
    r1 = test_client.get(f"/api/v1/repositories/{rid}/members")
    assert r1.status_code in (401, 403), (
        f"匿名成员列表未被打回（期望 401/403）: {r1.status_code} {r1.text[:200]}"
    )
    # 私仓 LFS batch 匿名 → 401（lfs_controller，handler 内 _authenticate_batch_user）
    r2 = test_client.post(
        f"/api/v1/repositories/{rid}/lfs/objects/batch",
        json={"operation": "download", "objects": [{"oid": "0" * 64, "size": 1}]},
    )
    assert r2.status_code in (401, 403), (
        f"匿名 LFS batch 未被打回（期望 401/403）: {r2.status_code} {r2.text[:200]}"
    )


def test_write_guard_uses_optional_user():
    """require_repo_permission 必须挂 get_optional_user（顺序自洽）。

    挂 get_current_user 时依赖层会在函数体前对匿名请求先抛 401，把
    「缺仓 404」压成 401→404——与 require_repo_read 的 404→401 顺序不自洽，
    正确性只能靠外层读守卫兜底。
    """
    from app.core.permissions import Action, require_repo_permission

    dep = require_repo_permission(Action.REPO_WRITE, "write files")
    param = _inspect.signature(dep).parameters["current_user"]
    # fastapi.params.Depends 挂被依赖对象在 .dependency（.call 属于 Dependant）
    target = getattr(param.default, "dependency", None)
    assert target is not None and target.__name__ == "get_optional_user", (
        "写守卫的 current_user 依赖必须是 get_optional_user"
        "（缺仓 404 先于匿名 401 的前提）"
    )