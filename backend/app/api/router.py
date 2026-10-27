"""
API 路由配置与注册模块

集中管理所有 API 路由的：
1. 路由注册顺序
2. 路由依赖关系

前缀常量与 get_route_prefix 已拆分至 api/prefixes.py（打破循环导入：
v1 路由只依赖无副作用的 prefixes，不再反向 import 本模块）。
"""
from app.api.prefixes import (  # noqa: F401  # re-export 兼容旧导入
    API_V1_PREFIX,
    ROUTES,
    get_api_version,
    get_route_prefix,
)
from fastapi import APIRouter


def create_api_router() -> APIRouter:
    """
    创建并配置 API v1 路由主路由器

    按照特定顺序注册所有 controller 路由：
    1. app_controller - 根路由和健康检查（最先注册）
    2. repository_browser - 需在 repository 之前注册
    3. 其他业务路由
    4. debug 路由
    5. error 和 websocket 路由

    Returns:
        APIRouter: 配置好的 API v1 路由器
    """
    api_v1_router = APIRouter(tags=["api-v1"])

    # 1. 应用管理路由（根路由 "/" 需要最先注册）
    from app.api.v1.app_controller import router as app_router
    api_v1_router.include_router(app_router)

    # 1.5 Agent 管理面（/api/app/agent/*，依赖 app_controller 的权限函数）
    from app.api.v1.agent_admin_controller import router as agent_admin_router
    api_v1_router.include_router(agent_admin_router)

    # 1.6 搜索/embedding 管理面（/api/app/search/*，与 LLM 链路分端点）
    from app.api.v1.search_admin_controller import router as search_admin_router
    api_v1_router.include_router(search_admin_router)

    # 2. 仓库浏览器（需在仓库路由之前注册，避免路由冲突）
    from app.api.v1.repository_browser_controller import router as repository_browser_router
    api_v1_router.include_router(repository_browser_router)

    # 3. 认证路由
    from app.api.v1.auth_controller import router as auth_router
    api_v1_router.include_router(auth_router)

    # 3a. Git HTTP Smart Protocol 认证路由
    # 用于 Nginx auth_request 子请求验证，必须先于 API 代理路由注册
    from app.api.v1.git_auth_controller import router as git_auth_router
    api_v1_router.include_router(git_auth_router, prefix=API_V1_PREFIX)

    # 3a2. 协作编辑内部回调路由（collab-gateway/Hocuspocus 服务间调用）
    from app.api.v1.collab_internal_controller import router as collab_internal_router
    api_v1_router.include_router(collab_internal_router, prefix=API_V1_PREFIX)

    # 3a3. Git hook 内部回调路由（git-cgi/sshd 容器 pre/post-receive）
    from app.api.v1.git_hook_controller import router as git_hook_router
    api_v1_router.include_router(git_hook_router, prefix=API_V1_PREFIX)

    # 3b. OAuth 认证路由
    from app.api.v1.oauth_controller import router as oauth_router
    api_v1_router.include_router(oauth_router)

    # 3c. OAuth 账号管理路由
    from app.api.v1.oauth_controller import account_router
    api_v1_router.include_router(account_router)

    # 4. 用户管理路由
    from app.api.v1.user_controller import router as user_router
    api_v1_router.include_router(user_router)

    # 6. 仓库成员路由
    from app.api.v1.repository_member_controller import router as repository_member_router
    api_v1_router.include_router(repository_member_router)

    # 6b. Fork 管理路由（需在仓库路由之后，分支路由之前）
    from app.api.v1.fork_controller import router as fork_router
    api_v1_router.include_router(fork_router)

    # 6c. Star 管理路由
    from app.api.v1.star_controller import router as star_router
    api_v1_router.include_router(star_router)

    # 6c-bis. Watch 管理路由
    from app.api.v1.watch_controller import router as watch_router
    api_v1_router.include_router(watch_router)

    # 6c-ter. 协作邀请链接路由
    from app.api.v1.collab_invite_controller import router as collab_invite_router
    api_v1_router.include_router(collab_invite_router)

    # 6c-quater. 协作会话级权限覆盖路由（改权限/踢人）
    from app.api.v1.collab_session_controller import router as collab_session_router
    api_v1_router.include_router(collab_session_router)

    # 6d. Repo Label 管理路由
    from app.api.v1.label_controller import router as label_router
    api_v1_router.include_router(label_router)

    # 6d-bis. 行内评论（Discussions）路由
    # （历史上需避开 /{owner}/{repo} 通配；根治后约束消除，保留注册位避免扰动）
    from app.api.v1.file_comment_controller import router as file_comment_router
    api_v1_router.include_router(file_comment_router)

    # 6e. LFS 管理路由
    from app.api.v1.lfs_controller import path_router as lfs_path_router, router as lfs_router
    api_v1_router.include_router(lfs_router)
    # git-lfs 客户端入口（/api/v1/lfs/{owner}/{repo}/batch）：独立前缀
    # （历史注释称需避开 repositories 通配路由，后无该约束）
    api_v1_router.include_router(lfs_path_router)

    # 7. 分支管理路由
    from app.api.v1.branch_controller import router as branch_router
    api_v1_router.include_router(branch_router)

    # 8. 提交管理路由
    from app.api.v1.commit_controller import router as commit_router
    api_v1_router.include_router(commit_router)

    # 8b. Tag 管理路由
    # （历史注释称须在 repository 通配之前，后无该约束）
    from app.api.v1.tag_controller import router as tag_router
    api_v1_router.include_router(tag_router)

    # 9. Pull Request 路由
    from app.api.v1.pull_request_controller import router as pull_request_router
    api_v1_router.include_router(pull_request_router)

    # 9c. PR Label 路由
    from app.api.v1.pr_label_controller import router as pr_label_router
    api_v1_router.include_router(pr_label_router)

    # 9b. Release 管理路由（需在 Pull Request 之后）
    from app.api.v1.release_controller import router as release_router
    api_v1_router.include_router(release_router)

    # 10. Issue 管理路由
    from app.api.v1.issue_controller import router as issue_router
    api_v1_router.include_router(issue_router)

    # 11. SSH Key 管理路由
    from app.api.v1.key_controller import router as key_router
    api_v1_router.include_router(key_router)

    # 11b. Webhook 管理路由
    from app.api.v1.webhook_controller import router as webhook_router
    api_v1_router.include_router(webhook_router)

    # 11c. Stats 路由
    from app.api.v1.stats_controller import router as stats_router
    api_v1_router.include_router(stats_router)

    # 11d. Activity 路由
    from app.api.v1.activity_controller import router as activity_router
    api_v1_router.include_router(activity_router)

    # 11f. Notification 路由
    from app.api.v1.notification_controller import router as notification_router
    api_v1_router.include_router(notification_router)

    # 11g. Room 路由
    from app.api.v1.room_controller import router as room_router
    api_v1_router.include_router(room_router)

    # 11g-bis. DM 私聊路由
    from app.api.v1.dm_controller import router as dm_router
    api_v1_router.include_router(dm_router)

    # 11h. Chat 路由
    from app.api.v1.chat_controller import router as chat_router
    api_v1_router.include_router(chat_router)

    # 11e. Search 路由
    from app.api.v1.search_controller import router as search_router
    api_v1_router.include_router(search_router)

    # 11e2. 跨仓库 Search 路由
    from app.api.v1.search_controller import global_search_router
    api_v1_router.include_router(global_search_router)

    # 11e3. 内置 Agent 路由（作业/步骤）
    from app.api.v1.agent_controller import router as agent_router
    api_v1_router.include_router(agent_router)

    # 11f. Build 路由
    from app.api.v1.build_controller import router as build_router
    api_v1_router.include_router(build_router)

    # 5. 仓库管理路由（/{repo_id} 域，UUID 唯一寻址）
    # 放在其他仓库子路由（issues/pull-requests/builds/search 等）之后注册。
    # 原 `/{owner}/{repo}` 两段通配已搬至固定前缀 path_router，
    # 本 router 不再含相邻双通配，「必须最后」的历史约束随之消除（保留现位避免无谓扰动，
    # 全量遮蔽断言见 tests/test_route_order_guard.py）。
    from app.api.v1.repository_controller import router as repository_router
    api_v1_router.include_router(repository_router)

    # 5b. slug 导航别名解析（固定前缀 /api/v1/repo/{owner}/{repo}）
    # 固定段 `repo` 与 /api/v1/repositories 命名空间段数/字面量双重区分，无遮蔽面。
    from app.api.v1.repository_controller import path_router as repository_path_router
    api_v1_router.include_router(repository_path_router)

    # 12. Debug 路由（仅在调试模式下可用）
    from app.api.v1.debug_controller import router as debug_router
    api_v1_router.include_router(debug_router)

    # 12. 错误处理路由
    from app.api.v1.error import router as error_router
    api_v1_router.include_router(error_router)

    # 13. WebSocket 路由（单独处理，因为 WebSocket 使用不同的协议）
    from app.api.ws import router as websocket_router
    api_v1_router.include_router(websocket_router)

    return api_v1_router


# 向后兼容：保留 api_v1_router 导出
api_v1_router = create_api_router()