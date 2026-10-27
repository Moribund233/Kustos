"""路由顺序防回潮断言

当年的原话是「`repository_controller` 的 `/{owner}/{repo}` 通配必须最后注册」，
但那只是**注册顺序**；真实约束是**匹配顺序**——Starlette 先注册者胜出，所以
「两段 GET」的字面量/半字面量路由若排在通配之后就会被整个遮蔽。

**根治**：slug 解析路由搬离 `/api/v1/repositories` 命名空间、改用固定
前缀 `/api/v1/repo/{owner}/{repo}`——段数与字面量双重区分，类遮蔽在结构上
不可能发生。本文件的断言从「顺序压制」升级为「结构不可能」：

1. **全量金丝雀断言**（保留）：把每条路由的路径参数替换成金丝雀值，按注册顺序
   解析回「第一个 FULL 匹配」，断言它解析回**自己**。任何被遮蔽的路由都会列名报错。
2. **结构断言**：`/api/v1/repositories/*` 下不得存在相邻双通配路由
   （`/{a}/{b}` 形状）——那正是历史遮蔽事故的形状根源。
3. **行为锚点**（保留）：真实发一次请求，确认 `/access` 落到正确的 handler——
   被遮蔽时会走 owner/repo 解析并返回 404，正确时因缺 `user_id` 查询参数返回 422。

为什么不用 FastAPI 的 low_priority：0.141 的 ``_low_priority_routes`` 只对 SPA
前端兜底开放（``_low_priority_routes.append(self._frontend_routes)``），没有公共
API 可标记业务路由——因此根治手段是搬固定前缀，而非依赖顺序或优先级标记。

新版 FastAPI 的 include_router 是懒加载的（``app.routes`` 里是 ``_IncludedRouter``
包装器），需经 ``openapi()`` 展开并递归 ``original_router.routes``——与
``scripts/verify_api_contract.py`` 同一套取路由方式。
"""
import re
import uuid as uuid_mod

import pytest
from fastapi.routing import APIRoute
from starlette.routing import Match

#: 金丝雀值：路径参数统一替换成它（匹配发生在类型校验之前，形状有效即可）
_CANARY = str(uuid_mod.uuid4())

#: 结构断言的作用域：资源寻址命名空间（曾发生相邻双通配遮蔽）
_REPOS_NS = "/api/v1/repositories"


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


def _resolve(flat, path: str, method: str):
    """按注册顺序取第一个 FULL 匹配的端点名（复刻 Starlette 的匹配语义）"""
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "root_path": "",
        "headers": [],
        "query_string": b"",
    }
    for route in flat:
        match, _child = route.matches(scope)
        if match == Match.FULL:
            return route.endpoint.__name__
    return None


def test_route_table_expanded(fastapi_app):
    """先自检：路由展开没坏（懒加载包装器递归失败会退化成个位数）"""
    flat = _flatten(fastapi_app.routes)
    assert len(flat) > 200, f"路由仅展开 {len(flat)} 条，_flatten 逻辑失效"


def test_no_route_is_shadowed(fastapi_app):
    """全量断言：每条路由的具名路径都要解析回它自己（防回潮）"""
    flat = _flatten(fastapi_app.routes)
    shadowed = []
    skipped = 0

    for route in flat:
        if ":path" in route.path or "{path" in route.path:
            skipped += 1  # catch-all 无法用金丝雀表达，单独由断言 2 覆盖
            continue
        concrete = re.sub(r"\{[^}]+\}", _CANARY, route.path)
        methods = sorted(
            m for m in (route.methods or {"GET"}) if m not in ("HEAD", "OPTIONS")
        )
        if not methods:
            continue
        got = _resolve(flat, concrete, methods[0])
        want = route.endpoint.__name__
        if got != want:
            shadowed.append(
                f"  {methods[0]:6} {route.path} ({want}) 被先注册的 {got} 抢先匹配"
            )

    assert not shadowed, (
        "以下路由被更早注册的路由遮蔽（通配/字面量路由必须最后注册，"
        "或改用固定前缀根除）：\n" + "\n".join(shadowed)
    )
    assert skipped < 10, f"catch-all 路由过多，跳过 {skipped} 条（需人工确认）"


def test_no_adjacent_wildcards_in_repos_namespace(fastapi_app):
    """结构断言：`/api/v1/repositories/*` 下不得有相邻双通配路由

    `/{a}/{b}` 形状是历史遮蔽事故的根源——它与 `/{repo_id}/<字面量>` 同为两段
    路径，先注册者胜出，顺序一动就翻车。把 slug 解析搬去固定前缀
    `/api/v1/repo/{owner}/{repo}` 后，本命名空间应只存在「UUID 段 + 字面量」
    形状；任何新注册的相邻双通配路由都会在这里被拦下（而非等线上遮蔽）。
    """
    flat = _flatten(fastapi_app.routes)
    offenders = [
        r.path for r in flat
        if r.path.startswith(_REPOS_NS) and re.search(r"\{[^}]+\}/\{[^}]+\}", r.path)
    ]
    assert not offenders, (
        "路由顺序回潮：以下路由在资源寻址命名空间使用相邻双通配（应改固定前缀）：\n"
        + "\n".join(f"  {p}" for p in offenders)
    )


def test_slug_resolver_at_fixed_prefix(fastapi_app):
    """结构断言：slug 解析器只以固定前缀暴露，不回流到 UUID 命名空间

    口径：UUID `{repo_id}` 是 API 唯一寻址；slug 是导航别名解析器，
    必须待在 `/api/v1/repo/{owner}/{repo}`（固定段隔离），不得回到
    `/api/v1/repositories/...` 下重开第二套寻址。
    """
    flat = _flatten(fastapi_app.routes)
    by_path = [r for r in flat if r.endpoint.__name__ == "get_repository_by_path"]
    assert len(by_path) == 1, f"get_repository_by_path 应恰有 1 条，实际 {len(by_path)}"
    assert by_path[0].path == "/api/v1/repo/{owner}/{repo}", (
        f"slug 解析器应回固定前缀 /api/v1/repo/{{owner}}/{{repo}}，实际 {by_path[0].path}"
    )


def test_access_route_not_shadowed_behaviour(fastapi_app, test_client, auth_headers):
    """行为锚点：缺 user_id 查询参数应由自身 handler 报 422

    若被 `/{owner}/{repo}` 遮蔽，请求会走 owner/repo 解析并返回 404，
    因此 422 是「路由正确」的直接证据。

    注：必须用**存在的**仓库——读守卫对缺仓先报 404（先于参数校验），
    随机 UUID 会把 422 信号吃掉、与被遮蔽的 404 不可区分。
    """
    created = test_client.post(
        "/api/v1/repositories",
        json={"name": "route-anchor-access", "description": "anchor", "is_public": True},
        headers=auth_headers,
    )
    assert created.status_code == 200, created.text
    repo_id = created.json()["id"]
    response = test_client.get(
        f"/api/v1/repositories/{repo_id}/access",
        headers=auth_headers,
    )
    assert response.status_code == 422, (
        f"期望 422（缺 user_id），实际 {response.status_code}：{response.text[:200]}"
    )
