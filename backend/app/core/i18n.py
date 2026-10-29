"""
后端国际化

根据 `Accept-Language` 请求头将业务错误消息翻译为对应语言。
默认语言为中文 (zh)，次选英文 (en)。

错误消息通过稳定的 `error_code`（如 `room_not_found`）与语言关联；
未携带 `error_code` 的异常沿用其原始 `detail`，保证向后兼容。
"""
from typing import Optional

# 默认语言与支持语言
LOCALE_ZH = "zh"
LOCALE_EN = "en"
DEFAULT_LOCALE = LOCALE_ZH
SUPPORTED_LOCALES = {LOCALE_ZH, LOCALE_EN}

# 错误码 → 各语言消息映射
ERROR_MESSAGES: dict[str, dict[str, str]] = {
    # =========================================================
    # 实时协作 / 聊天
    # =========================================================
    "room_not_found": {
        LOCALE_ZH: "房间不存在",
        LOCALE_EN: "Room not found",
    },
    "room_closed": {
        LOCALE_ZH: "房间已关闭",
        LOCALE_EN: "Room has been closed",
    },
    "room_not_member": {
        LOCALE_ZH: "你不是该房间的成员",
        LOCALE_EN: "You are not a member of this room",
    },
    "room_already_exists": {
        LOCALE_ZH: "该仓库已有关联房间",
        LOCALE_EN: "Room already exists for this repository",
    },
    "room_invalid_role": {
        LOCALE_ZH: "无效的角色",
        LOCALE_EN: "Invalid role",
    },
    "room_member_not_found": {
        LOCALE_ZH: "成员不存在",
        LOCALE_EN: "Member not found",
    },
    "message_content_required": {
        LOCALE_ZH: "消息内容不能为空",
        LOCALE_EN: "Message content cannot be empty",
    },
    "message_not_found": {
        LOCALE_ZH: "消息不存在",
        LOCALE_EN: "Message not found",
    },
    "message_edit_own_only": {
        LOCALE_ZH: "只能编辑自己的消息",
        LOCALE_EN: "Only your own messages can be edited",
    },
    "message_delete_forbidden": {
        LOCALE_ZH: "没有权限删除此消息",
        LOCALE_EN: "You do not have permission to delete this message",
    },
    "message_room_membership": {
        LOCALE_ZH: "你不是该房间的成员",
        LOCALE_EN: "You are not a member of this room",
    },
    "invalid_emoji": {
        LOCALE_ZH: "表情不合法",
        LOCALE_EN: "Invalid emoji",
    },
    "reaction_duplicate": {
        LOCALE_ZH: "你已回应过该表情",
        LOCALE_EN: "You have already reacted with this emoji",
    },

    # =========================================================
    # 通用 / 请求校验
    # =========================================================
    "validation_error": {
        LOCALE_ZH: "请求参数校验失败",
        LOCALE_EN: "Validation Error",
    },
    "request_validation_error": {
        LOCALE_ZH: "请求参数校验失败",
        LOCALE_EN: "Validation Error",
    },
    "server_busy": {
        LOCALE_ZH: "服务器繁忙，请稍后再试",
        LOCALE_EN: "Server is busy, please retry later",
    },

    # =========================================================
    # 应用管理 / 配置
    # =========================================================
    "app_admin_or_debug_required": {
        LOCALE_ZH: "该操作需要管理员权限或调试模式",
        LOCALE_EN: "This operation requires admin privileges or debug mode",
    },
    "app_local_auth_required": {
        LOCALE_ZH: "该操作需要本地认证或调试模式",
        LOCALE_EN: "This operation requires local authentication or debug mode",
    },
    "app_invalid_date_format": {
        LOCALE_ZH: "日期格式无效，应为 YYYY-MM-DD",
        LOCALE_EN: "Invalid date format. Expected YYYY-MM-DD",
    },
    "app_invalid_retention_days": {
        LOCALE_ZH: "保留天数必须大于等于 1",
        LOCALE_EN: "Retention days must be at least 1",
    },
    "app_restart_failed": {
        LOCALE_ZH: "重启失败",
        LOCALE_EN: "Failed to restart the application",
    },
    "app_log_read_failed": {
        LOCALE_ZH: "读取日志文件失败",
        LOCALE_EN: "Failed to read log files",
    },
    "config_debug_or_admin_required": {
        LOCALE_ZH: "该操作需要调试模式或管理员权限",
        LOCALE_EN: "This operation requires debug mode or admin privileges",
    },
    "config_validation_failed": {
        LOCALE_ZH: "配置验证失败",
        LOCALE_EN: "Configuration validation failed",
    },
    "config_persist_failed": {
        LOCALE_ZH: "配置持久化失败，修改未生效",
        LOCALE_EN: "Failed to persist configuration; change was not applied",
    },
    "config_bootstrap_readonly": {
        LOCALE_ZH: "该配置属引导层（只允许通过环境变量配置），修改未生效",
        LOCALE_EN: "Bootstrap-level setting (environment variables only); change was not applied",
    },
    "config_secret_decrypt_failed": {
        LOCALE_ZH: "配置密钥解密失败（主密钥缺失或与保存时不一致），修改未生效",
        LOCALE_EN: "Failed to decrypt stored secret (master key missing or changed); change was not applied",
    },
    "search_config_invalid": {
        LOCALE_ZH: "搜索/embedding 配置键或值非法，修改未生效",
        LOCALE_EN: "Invalid search/embedding configuration key or value; change was not applied",
    },
    "search_config_version_conflict": {
        LOCALE_ZH: "搜索/embedding 配置已被他人修改，请重新加载后重试",
        LOCALE_EN: "Search/embedding configuration was modified by someone else; reload and retry",
    },
    # ---- 应用级权限（check_app_permission） ----
    "app_admin_required": {
        LOCALE_ZH: "该操作需要管理员权限（调试模式下仅对本机来源开放）",
        LOCALE_EN: "Admin privileges required (in debug mode only loopback sources are allowed)",
    },
    # ---- 调试端点（debug_controller） ----
    "debug_disabled": {
        LOCALE_ZH: "调试端点仅在调试模式下可用",
        LOCALE_EN: "Debug endpoints are only available in debug mode",
    },
    "debug_config_template_missing": {
        LOCALE_ZH: "config.example.toml 不存在，无法重置配置",
        LOCALE_EN: "config.example.toml does not exist, cannot reset configuration",
    },

    # =========================================================
    # 用户 / 认证 / OAuth / 通知
    # =========================================================
    "user_not_found": {
        LOCALE_ZH: "用户不存在",
        LOCALE_EN: "User not found",
    },
    "user_not_found_inactive": {
        LOCALE_ZH: "用户不存在或已禁用",
        LOCALE_EN: "User not found or inactive",
    },
    "user_update_forbidden": {
        LOCALE_ZH: "没有权限更新该用户",
        LOCALE_EN: "You don't have permission to update this user",
    },
    "user_credentials_required": {
        LOCALE_ZH: "用户名与密码不能为空",
        LOCALE_EN: "Username and password are required",
    },
    "user_passwords_required": {
        LOCALE_ZH: "旧密码与新密码不能为空",
        LOCALE_EN: "Old password and new password are required",
    },
    "user_password_too_short": {
        LOCALE_ZH: "新密码长度不能少于 6 个字符",
        LOCALE_EN: "New password must be at least 6 characters",
    },
    "avatar_not_found": {
        LOCALE_ZH: "头像不存在",
        LOCALE_EN: "Avatar not found",
    },
    "avatar_invalid_format": {
        LOCALE_ZH: "头像图片格式不支持",
        LOCALE_EN: "Invalid image format",
    },
    "avatar_too_large": {
        LOCALE_ZH: "头像文件过大",
        LOCALE_EN: "Avatar file is too large",
    },
    "username_already_exists": {
        LOCALE_ZH: "用户名已存在",
        LOCALE_EN: "Username already exists",
    },
    "email_already_exists": {
        LOCALE_ZH: "邮箱已被使用",
        LOCALE_EN: "Email already exists",
    },
    "invalid_credentials": {
        LOCALE_ZH: "用户名或密码错误",
        LOCALE_EN: "Invalid username or password",
    },
    "invalid_old_password": {
        LOCALE_ZH: "原密码错误",
        LOCALE_EN: "Invalid old password",
    },
    "invalid_refresh_token": {
        LOCALE_ZH: "刷新令牌无效或已过期",
        LOCALE_EN: "Invalid or expired refresh token",
    },
    "oauth_invalid_state": {
        LOCALE_ZH: "OAuth 状态无效或已过期",
        LOCALE_EN: "Invalid or expired OAuth state",
    },
    "oauth_no_matching_user": {
        LOCALE_ZH: "关联的 OAuth 账号没有匹配的用户",
        LOCALE_EN: "Linked OAuth account has no matching user",
    },
    "oauth_account_not_found": {
        LOCALE_ZH: "未找到关联的第三方账号",
        LOCALE_EN: "Linked account not found",
    },
    "notification_not_found": {
        LOCALE_ZH: "通知不存在",
        LOCALE_EN: "Notification not found",
    },
    # ---- HTTP 语义（dependencies / permissions / git_hook …） ----
    "auth_required": {
        LOCALE_ZH: "需要认证",
        LOCALE_EN: "Authentication required",
    },
    "invalid_token": {
        LOCALE_ZH: "无效或过期的 token",
        LOCALE_EN: "Invalid or expired token",
    },
    "user_inactive": {
        LOCALE_ZH: "用户已禁用",
        LOCALE_EN: "User is inactive",
    },
    "admin_required": {
        LOCALE_ZH: "需要管理员权限",
        LOCALE_EN: "Admin privileges required",
    },
    "git_hook_disabled": {
        LOCALE_ZH: "Git hook API 未启用（未配置 KUSTOS_GIT_HOOK_SECRET）",
        LOCALE_EN: "Git hook API disabled (KUSTOS_GIT_HOOK_SECRET not configured)",
    },

    # =========================================================
    # 仓库 / 分支 / 提交 / 文件浏览
    # =========================================================
    "repository_not_found": {
        LOCALE_ZH: "仓库不存在",
        LOCALE_EN: "Repository not found",
    },
    "repository_name_required": {
        LOCALE_ZH: "仓库名称必填",
        LOCALE_EN: "Repository name is required",
    },
    # ---- 内置 Agent ----
    "agent_disabled": {
        LOCALE_ZH: "内置 Agent 未启用",
        LOCALE_EN: "Built-in Agent is disabled",
    },
    "agent_base_url_not_allowed": {
        LOCALE_ZH: "base_url 不在允许列表内",
        LOCALE_EN: "base_url is not in the allowlist",
    },
    "agent_base_url_requires_api_key": {
        LOCALE_ZH: "请求级 base_url 需要同时携带 api_key",
        LOCALE_EN: "Request-level base_url requires api_key",
    },
    "agent_job_not_found": {
        LOCALE_ZH: "Agent 作业不存在",
        LOCALE_EN: "Agent job not found",
    },
    "agent_session_not_found": {
        LOCALE_ZH: "Agent 会话不存在",
        LOCALE_EN: "Agent session not found",
    },
    "agent_not_awaiting_approval": {
        LOCALE_ZH: "作业当前不处于待审批状态",
        LOCALE_EN: "Job is not awaiting approval",
    },
    "agent_user_concurrency_exceeded": {
        LOCALE_ZH: "当前并发 Agent 作业数已达上限，请稍后再试",
        LOCALE_EN: "Too many concurrent Agent jobs for this user",
    },
    "agent_global_concurrency_exceeded": {
        LOCALE_ZH: "Agent 服务繁忙，请稍后再试",
        LOCALE_EN: "Agent service is busy, please retry later",
    },
    "agent_daily_job_limit_exceeded": {
        LOCALE_ZH: "今日 Agent 作业数已达上限",
        LOCALE_EN: "Daily Agent job limit reached",
    },
    "agent_token_budget_exceeded": {
        LOCALE_ZH: "今日 Agent token 预算已用尽",
        LOCALE_EN: "Daily Agent token budget exhausted",
    },
    "agent_models_unavailable": {
        LOCALE_ZH: "模型列表获取失败（上游 /models 不可用）",
        LOCALE_EN: "Failed to fetch model list (upstream /models unavailable)",
    },
    "agent_base_url_forbidden": {
        LOCALE_ZH: "base_url 非法：仅支持不带凭据的 http/https 绝对 URL",
        LOCALE_EN: "Invalid base_url: credential-free absolute http/https URL required",
    },
    "agent_key_missing": {
        LOCALE_ZH: "容器未注入 API key 环境变量（名称见 GET /api/app/agent/key-status，注入后 recreate）",
        LOCALE_EN: "API key environment variable not injected (see GET /api/app/agent/key-status, then recreate)",
    },
    "agent_provider_not_found": {
        LOCALE_ZH: "未知的 provider",
        LOCALE_EN: "Unknown provider",
    },
    "agent_upstream_auth_rejected": {
        LOCALE_ZH: "上游拒绝凭证（key 无效或无权限）",
        LOCALE_EN: "Upstream rejected the credentials (key invalid or unauthorized)",
    },
    "agent_config_version_conflict": {
        LOCALE_ZH: "配置已被他人修改，请重新加载后再保存",
        LOCALE_EN: "Configuration was modified by someone else; reload and save again",
    },
    "agent_config_invalid": {
        LOCALE_ZH: "Agent 配置校验失败（键不在可写白名单或值超出约束）",
        LOCALE_EN: "Agent configuration validation failed (key not writable or value out of range)",
    },

    "repository_not_found_on_disk": {
        LOCALE_ZH: "仓库物理目录不存在",
        LOCALE_EN: "Repository not found on disk",
    },
    "repository_open_failed": {
        LOCALE_ZH: "打开仓库失败",
        LOCALE_EN: "Failed to open repository",
    },
    "repository_access_denied": {
        LOCALE_ZH: "没有该仓库的访问权限",
        LOCALE_EN: "You do not have access to this repository",
    },
    "repository_required_fields": {
        LOCALE_ZH: "名称、路径和所有者不能为空",
        LOCALE_EN: "Name, path and owner_id are required",
    },
    "repository_path_already_exists": {
        LOCALE_ZH: "仓库路径已存在",
        LOCALE_EN: "Repository path already exists",
    },
    "repository_already_starred": {
        LOCALE_ZH: "仓库已被标星",
        LOCALE_EN: "Repository already starred",
    },
    "repository_not_starred": {
        LOCALE_ZH: "仓库未被标星",
        LOCALE_EN: "Repository is not starred",
    },
    "source_repository_not_found": {
        LOCALE_ZH: "源仓库不存在",
        LOCALE_EN: "Source repository not found",
    },
    "repo_not_a_fork": {
        LOCALE_ZH: "该仓库不是 Fork 仓库",
        LOCALE_EN: "This repository is not a fork",
    },
    "fork_not_authorized": {
        LOCALE_ZH: "没有权限 Fork 该仓库",
        LOCALE_EN: "Not authorized to fork this repository",
    },
    "fork_already_exists": {
        LOCALE_ZH: "您已将该仓库 Fork 到其他位置",
        LOCALE_EN: "You have already forked this repository",
    },
    "fork_failed": {
        LOCALE_ZH: "Fork 仓库失败",
        LOCALE_EN: "Failed to fork repository",
    },
    "fork_sync_not_authorized": {
        LOCALE_ZH: "没有权限同步该仓库",
        LOCALE_EN: "Not authorized to sync this repository",
    },
    "fork_sync_failed": {
        LOCALE_ZH: "同步 Fork 仓库失败",
        LOCALE_EN: "Failed to sync forked repository",
    },
    "repo_has_no_commits": {
        LOCALE_ZH: "该仓库没有提交记录",
        LOCALE_EN: "No commits found in this repository",
    },
    "branch_not_found": {
        LOCALE_ZH: "分支不存在",
        LOCALE_EN: "Branch not found",
    },
    "branch_name_required": {
        LOCALE_ZH: "分支名称不能为空",
        LOCALE_EN: "Branch name is required",
    },
    "branch_already_exists": {
        LOCALE_ZH: "分支已存在",
        LOCALE_EN: "Branch already exists",
    },
    "branch_delete_default_forbidden": {
        LOCALE_ZH: "不能删除默认分支",
        LOCALE_EN: "Cannot delete the default branch",
    },
    "branch_delete_protected_forbidden": {
        LOCALE_ZH: "受保护分支不能删除（请先取消保护）",
        LOCALE_EN: "Protected branch cannot be deleted (unprotect it first)",
    },
    "branch_direct_write_forbidden": {
        LOCALE_ZH: "该分支要求 Pull Request，不允许直接写入",
        LOCALE_EN: "Branch requires a pull request; direct write is not allowed",
    },
    "branch_repo_mismatch": {
        LOCALE_ZH: "该分支不属于此仓库",
        LOCALE_EN: "Branch does not belong to this repository",
    },
    "default_branch_not_found": {
        LOCALE_ZH: "默认分支不存在",
        LOCALE_EN: "Default branch not found",
    },
    "branch_ref_not_found": {
        LOCALE_ZH: "分支引用不存在",
        LOCALE_EN: "Branch ref not found",
    },
    "branch_has_no_commits": {
        LOCALE_ZH: "该分支没有提交记录",
        LOCALE_EN: "No commits found in this branch",
    },
    "commit_not_found": {
        LOCALE_ZH: "提交不存在",
        LOCALE_EN: "Commit not found",
    },
    "commit_field_required": {
        LOCALE_ZH: "字段不能为空",
        LOCALE_EN: "Field is required",
    },
    "commit_hash_already_exists": {
        LOCALE_ZH: "提交哈希已存在",
        LOCALE_EN: "Commit hash already exists",
    },
    "path_required": {
        LOCALE_ZH: "路径不能为空",
        LOCALE_EN: "Path is required",
    },
    "path_not_found": {
        LOCALE_ZH: "路径不存在",
        LOCALE_EN: "Path not found",
    },
    "search_ref_not_found": {
        LOCALE_ZH: "引用不存在或无法解析",
        LOCALE_EN: "Ref not found or unresolvable",
    },
    "search_ref_scan_requires_repo": {
        LOCALE_ZH: "按引用查找符号需要仓库路径",
        LOCALE_EN: "Symbol lookup by ref requires a repository path",
    },
    "path_is_directory": {
        LOCALE_ZH: "该路径是目录而非文件",
        LOCALE_EN: "The path is a directory, not a file",
    },
    "path_not_directory": {
        LOCALE_ZH: "该路径不是目录",
        LOCALE_EN: "The path is not a directory",
    },
    "file_invalid": {
        LOCALE_ZH: "不是有效的文件",
        LOCALE_EN: "Not a valid file",
    },
    "file_not_found": {
        LOCALE_ZH: "文件不存在",
        LOCALE_EN: "File not found",
    },
    "head_commit_required": {
        LOCALE_ZH: "需要提供 HEAD 提交",
        LOCALE_EN: "Head commit is required",
    },
    "base_ref_not_found": {
        LOCALE_ZH: "基础引用不存在",
        LOCALE_EN: "Base ref not found",
    },

    # =========================================================
    # 成员 / 标签 / SSH 密钥
    # =========================================================
    "member_not_found": {
        LOCALE_ZH: "仓库中不存在该成员",
        LOCALE_EN: "Member not found in this repository",
    },
    "member_user_id_required": {
        LOCALE_ZH: "用户 ID 不能为空",
        LOCALE_EN: "User ID is required",
    },
    "member_already_exists": {
        LOCALE_ZH: "该用户已是仓库成员",
        LOCALE_EN: "User is already a member of this repository",
    },
    "member_invalid_role": {
        LOCALE_ZH: "角色无效",
        LOCALE_EN: "Invalid role",
    },
    "member_remove_owner_forbidden": {
        LOCALE_ZH: "不能移除仓库所有者",
        LOCALE_EN: "Cannot remove the repository owner",
    },
    "member_deactivate_owner_forbidden": {
        LOCALE_ZH: "不能停用仓库所有者",
        LOCALE_EN: "Cannot deactivate the repository owner",
    },
    "label_not_found": {
        LOCALE_ZH: "标签不存在",
        LOCALE_EN: "Label not found",
    },
    "label_name_required": {
        LOCALE_ZH: "标签名称不能为空",
        LOCALE_EN: "Label name is required",
    },
    "label_invalid_color": {
        LOCALE_ZH: "无效的颜色格式",
        LOCALE_EN: "Invalid color format",
    },
    "label_already_exists": {
        LOCALE_ZH: "标签已存在",
        LOCALE_EN: "Label already exists",
    },
    "label_already_added": {
        LOCALE_ZH: "标签已添加到该 Issue",
        LOCALE_EN: "Label already added to this issue",
    },
    "label_not_in_issue": {
        LOCALE_ZH: "该 Issue 中不存在此标签",
        LOCALE_EN: "Label not found in this issue",
    },
    "ssh_key_not_found": {
        LOCALE_ZH: "SSH 密钥不存在",
        LOCALE_EN: "SSH key not found",
    },
    "ssh_key_invalid_format": {
        LOCALE_ZH: "无效的 SSH 密钥格式",
        LOCALE_EN: "Invalid SSH key format",
    },
    "ssh_key_already_exists": {
        LOCALE_ZH: "SSH 密钥已存在",
        LOCALE_EN: "SSH key already exists",
    },
    "ssh_key_delete_forbidden": {
        LOCALE_ZH: "没有权限删除该 SSH 密钥",
        LOCALE_EN: "You don't have permission to delete this key",
    },

    # =========================================================
    # Issue / Pull Request
    # =========================================================
    "issue_not_found": {
        LOCALE_ZH: "Issue 不存在",
        LOCALE_EN: "Issue not found",
    },
    "issue_title_required": {
        LOCALE_ZH: "标题不能为空",
        LOCALE_EN: "Title is required",
    },
    "issue_invalid_priority": {
        LOCALE_ZH: "无效的优先级",
        LOCALE_EN: "Invalid priority",
    },
    "issue_already_closed": {
        LOCALE_ZH: "Issue 已关闭",
        LOCALE_EN: "Issue is already closed",
    },
    "issue_already_open": {
        LOCALE_ZH: "Issue 已打开",
        LOCALE_EN: "Issue is already open",
    },
    "issue_comment_required": {
        LOCALE_ZH: "评论内容不能为空",
        LOCALE_EN: "Comment content is required",
    },
    "pr_not_found": {
        LOCALE_ZH: "Pull Request 不存在",
        LOCALE_EN: "Pull request not found",
    },
    "pr_title_required": {
        LOCALE_ZH: "标题不能为空",
        LOCALE_EN: "Title is required",
    },
    "pr_branches_same": {
        LOCALE_ZH: "源分支与目标分支不能相同",
        LOCALE_EN: "Source and target branches cannot be the same",
    },
    "pr_not_draft": {
        LOCALE_ZH: "该 Pull Request 不是草稿",
        LOCALE_EN: "Pull request is not a draft",
    },
    "pr_invalid_status": {
        LOCALE_ZH: "Pull Request 已处于该状态",
        LOCALE_EN: "Pull request is already in this status",
    },
    "pr_invalid_status_for_update": {
        LOCALE_ZH: "当前状态的 Pull Request 不能更新",
        LOCALE_EN: "Cannot update pull request in its current status",
    },
    "pr_invalid_status_for_merge": {
        LOCALE_ZH: "当前状态的 Pull Request 不能合并",
        LOCALE_EN: "Cannot merge pull request in its current status",
    },
    "pr_merger_not_found": {
        LOCALE_ZH: "合并用户不存在",
        LOCALE_EN: "Merger not found",
    },
    "pr_merge_forbidden": {
        LOCALE_ZH: "没有权限合并该 Pull Request",
        LOCALE_EN: "You don't have permission to merge this pull request",
    },
    "pr_merge_conflict": {
        LOCALE_ZH: "存在合并冲突，请先解决冲突后再合并",
        LOCALE_EN: "Merge conflicts detected. Resolve conflicts before merging",
    },
    "pr_invalid_merge_method": {
        LOCALE_ZH: "无效的合并方式",
        LOCALE_EN: "Invalid merge method",
    },
    "pr_merge_failed": {
        LOCALE_ZH: "合并操作失败",
        LOCALE_EN: "Merge operation failed",
    },
    "pr_comment_required": {
        LOCALE_ZH: "评论内容不能为空",
        LOCALE_EN: "Comment content is required",
    },
    "pr_invalid_parent_comment": {
        LOCALE_ZH: "无效的父评论",
        LOCALE_EN: "Invalid parent comment",
    },
    "pr_invalid_review_status": {
        LOCALE_ZH: "无效的评审状态",
        LOCALE_EN: "Invalid review status",
    },
    "pr_diff_failed": {
        LOCALE_ZH: "获取 PR 差异失败",
        LOCALE_EN: "Failed to get PR diff",
    },
    "pr_base_branch_not_found": {
        LOCALE_ZH: "PR 目标分支不存在",
        LOCALE_EN: "PR base branch not found",
    },
    "pr_source_branch_not_found": {
        LOCALE_ZH: "PR 源分支不存在",
        LOCALE_EN: "PR source branch not found",
    },
    "pr_file_diff_failed": {
        LOCALE_ZH: "获取文件差异失败",
        LOCALE_EN: "Failed to get file diff",
    },
    "pr_reviewer_required": {
        LOCALE_ZH: "请至少指定一名评审人",
        LOCALE_EN: "Provide at least one reviewer",
    },
    "pr_reviewer_not_found": {
        LOCALE_ZH: "评审人不存在",
        LOCALE_EN: "Reviewer not found",
    },
    "pr_reviewer_not_member": {
        LOCALE_ZH: "请求的评审人不是该仓库成员",
        LOCALE_EN: "Requested reviewer is not a member of this repository",
    },
    "pr_review_request_not_found": {
        LOCALE_ZH: "评审请求不存在",
        LOCALE_EN: "Review request not found",
    },
    "pr_issue_link_not_found": {
        LOCALE_ZH: "该 Issue 未关联到此 Pull Request",
        LOCALE_EN: "Issue is not linked to this pull request",
    },

    # =========================================================
    # Release / 附件（聊天 / Release）
    # =========================================================
    "release_not_found": {
        LOCALE_ZH: "Release 不存在",
        LOCALE_EN: "Release not found",
    },
    "release_tag_not_found": {
        LOCALE_ZH: "该标签的 Release 不存在",
        LOCALE_EN: "Release with this tag not found",
    },
    "release_tag_already_exists": {
        LOCALE_ZH: "该标签的 Release 已存在",
        LOCALE_EN: "Release with this tag already exists",
    },
    "release_head_commit_failed": {
        LOCALE_ZH: "获取 HEAD 提交哈希失败",
        LOCALE_EN: "Failed to get HEAD commit hash",
    },
    "release_update_forbidden": {
        LOCALE_ZH: "没有权限更新该 Release",
        LOCALE_EN: "Not authorized to update this release",
    },
    "release_delete_forbidden": {
        LOCALE_ZH: "没有权限删除该 Release",
        LOCALE_EN: "Not authorized to delete this release",
    },
    "release_asset_add_forbidden": {
        LOCALE_ZH: "没有权限向该 Release 添加附件",
        LOCALE_EN: "Not authorized to add assets to this release",
    },
    "release_asset_delete_forbidden": {
        LOCALE_ZH: "没有权限删除该 Release 的附件",
        LOCALE_EN: "Not authorized to delete assets from this release",
    },
    "release_tag_create_failed": {
        LOCALE_ZH: "创建 Git 标签失败",
        LOCALE_EN: "Failed to create tag",
    },
    "release_tag_hash_failed": {
        LOCALE_ZH: "获取标签哈希失败",
        LOCALE_EN: "Failed to get tag hash",
    },
    "release_tag_delete_failed": {
        LOCALE_ZH: "删除 Git 标签失败",
        LOCALE_EN: "Failed to delete tag",
    },
    "release_tag_list_failed": {
        LOCALE_ZH: "列出 Git 标签失败",
        LOCALE_EN: "Failed to list tags",
    },
    "release_tag_get_failed": {
        LOCALE_ZH: "获取 Git 标签失败",
        LOCALE_EN: "Failed to get tag",
    },
    "asset_not_found": {
        LOCALE_ZH: "附件不存在",
        LOCALE_EN: "Asset not found",
    },
    "asset_too_large": {
        LOCALE_ZH: "附件大小不能超过 50MB",
        LOCALE_EN: "Attachment size cannot exceed 50MB",
    },
    "attachment_content_empty": {
        LOCALE_ZH: "附件内容为空",
        LOCALE_EN: "Attachment content is empty",
    },
    "attachment_not_found": {
        LOCALE_ZH: "附件不存在",
        LOCALE_EN: "Attachment not found",
    },
    "attachment_too_large": {
        LOCALE_ZH: "附件大小不能超过 20MB",
        LOCALE_EN: "Attachment size cannot exceed 20MB",
    },

    # =========================================================
    # Git 浏览器（Blame / 提交图 / 对比）
    # =========================================================
    "blame_failed": {
        LOCALE_ZH: "获取文件追溯信息失败",
        LOCALE_EN: "Failed to get file blame",
    },

    # =========================================================
    # Tag 管理
    # =========================================================
    "tag_not_found": {
        LOCALE_ZH: "标签不存在",
        LOCALE_EN: "Tag not found",
    },
    "tag_no_target": {
        LOCALE_ZH: "仓库没有可打标签的提交",
        LOCALE_EN: "Repository has no commit to tag",
    },
    "tag_list_failed": {
        LOCALE_ZH: "列出标签失败",
        LOCALE_EN: "Failed to list tags",
    },
    "tag_get_failed": {
        LOCALE_ZH: "获取标签失败",
        LOCALE_EN: "Failed to get tag",
    },
    "tag_create_failed": {
        LOCALE_ZH: "创建标签失败",
        LOCALE_EN: "Failed to create tag",
    },
    "tag_delete_failed": {
        LOCALE_ZH: "删除标签失败",
        LOCALE_EN: "Failed to delete tag",
    },

    # =========================================================
    # Build / Webhook
    # =========================================================
    "build_not_found": {
        LOCALE_ZH: "构建记录不存在",
        LOCALE_EN: "Build not found",
    },
    "webhook_not_found": {
        LOCALE_ZH: "Webhook 不存在",
        LOCALE_EN: "Webhook not found",
    },
    "webhook_view_forbidden": {
        LOCALE_ZH: "没有权限查看 Webhook",
        LOCALE_EN: "Not authorized to view webhook",
    },
    "webhook_create_forbidden": {
        LOCALE_ZH: "没有权限创建 Webhook",
        LOCALE_EN: "Not authorized to create webhook",
    },
    "webhook_update_forbidden": {
        LOCALE_ZH: "没有权限更新 Webhook",
        LOCALE_EN: "Not authorized to update webhook",
    },
    "webhook_delete_forbidden": {
        LOCALE_ZH: "没有权限删除 Webhook",
        LOCALE_EN: "Not authorized to delete webhook",
    },
    "webhook_test_forbidden": {
        LOCALE_ZH: "没有权限测试 Webhook",
        LOCALE_EN: "Not authorized to test webhook",
    },
    "webhook_invalid_url": {
        LOCALE_ZH: "无效的 URL",
        LOCALE_EN: "Invalid URL",
    },
    "webhook_events_required": {
        LOCALE_ZH: "至少需要指定一个事件",
        LOCALE_EN: "At least one event must be specified",
    },
    "webhook_invalid_event": {
        LOCALE_ZH: "无效的事件类型",
        LOCALE_EN: "Invalid event",
    },
    "webhook_invalid_content_type": {
        LOCALE_ZH: "无效的 content_type",
        LOCALE_EN: "Invalid content_type",
    },
    "webhook_delivery_not_found": {
        LOCALE_ZH: "投递记录不存在",
        LOCALE_EN: "Delivery not found",
    },
    "webhook_delivery_view_forbidden": {
        LOCALE_ZH: "没有权限查看投递记录",
        LOCALE_EN: "Not authorized to view deliveries",
    },

    # =========================================================
    # CI 回调 / Git Hook / LFS
    # =========================================================
    "build_ci_signature_not_configured": {
        LOCALE_ZH: "仓库未配置 CI 回调签名",
        LOCALE_EN: "CI callback signature not configured for repository",
    },
    "build_ci_signature_invalid": {
        LOCALE_ZH: "CI 回调签名无效",
        LOCALE_EN: "Invalid CI callback signature",
    },
    "lfs_s3_not_configured": {
        LOCALE_ZH: "尚未配置 S3 存储",
        LOCALE_EN: "S3 storage not yet configured",
    },
    "lfs_operation_unsupported": {
        LOCALE_ZH: "不支持的 LFS 操作",
        LOCALE_EN: "Unsupported LFS operation",
    },
    "lfs_object_too_large": {
        LOCALE_ZH: "LFS 对象超出大小上限",
        LOCALE_EN: "LFS object too large",
    },
    "lfs_object_size_mismatch": {
        LOCALE_ZH: "LFS 对象大小与声明不符",
        LOCALE_EN: "LFS object size mismatch",
    },
    "lfs_oid_invalid": {
        LOCALE_ZH: "LFS 对象 oid 非法（须为 64 位小写 sha256 摘要）",
        LOCALE_EN: "Invalid LFS object id (expected 64-char lowercase sha256)",
    },
    "lfs_hash_mismatch": {
        LOCALE_ZH: "LFS 对象内容与 oid 不一致",
        LOCALE_EN: "LFS object content does not match oid",
    },

    # =========================================================
    # 协作编辑 (collab gateway)
    # =========================================================
    "collab_invalid_dockey": {
        LOCALE_ZH: "docKey 格式非法, 应为 repository_id:branch:path",
        LOCALE_EN: "Invalid docKey format. Expected repository_id:branch:path",
    },
    "collab_invalid_repository_id": {
        LOCALE_ZH: "docKey 中 repository_id 非法",
        LOCALE_EN: "Invalid repository_id in docKey",
    },
    "collab_dockey_missing_parts": {
        LOCALE_ZH: "docKey 中 branch/path 不能为空",
        LOCALE_EN: "docKey branch/path cannot be empty",
    },
    "collab_invalid_internal_secret": {
        LOCALE_ZH: "内部密钥校验失败",
        LOCALE_EN: "Invalid internal secret",
    },
    "collab_repository_access_denied": {
        LOCALE_ZH: "没有该仓库的访问权限",
        LOCALE_EN: "No access to this repository",
    },
    "collab_repository_write_denied": {
        LOCALE_ZH: "没有该仓库的写入权限",
        LOCALE_EN: "No write access to this repository",
    },
    "collab_internal_disabled": {
        LOCALE_ZH: "协作内部 API 未启用",
        LOCALE_EN: "Collab internal API disabled",
    },
    "collab_binary_file": {
        LOCALE_ZH: "不支持协作编辑二进制文件",
        LOCALE_EN: "Binary files cannot be edited collaboratively",
    },
    "collab_content_too_large": {
        LOCALE_ZH: "文档内容超出上限",
        LOCALE_EN: "Document content exceeds the limit",
    },

    # =========================================================
    # 平台安全 / 权限裁决（补齐既有无词条 error_code）
    # =========================================================
    "author_or_admin_only": {
        LOCALE_ZH: "只有资源作者或仓库管理员可执行该操作",
        LOCALE_EN: "Only the author or repository admins can perform this action",
    },
    "admin_role_forbidden": {
        LOCALE_ZH: "只有管理员可以变更管理员角色",
        LOCALE_EN: "Only administrators can change the admin role",
    },
    "admin_self_demote_forbidden": {
        LOCALE_ZH: "管理员不能自行降级",
        LOCALE_EN: "Administrators cannot demote themselves",
    },
    "admin_delete_last_forbidden": {
        LOCALE_ZH: "不能删除最后一位管理员",
        LOCALE_EN: "Cannot delete the last administrator",
    },
    "admin_remove_last_forbidden": {
        LOCALE_ZH: "不能移除最后一位管理员",
        LOCALE_EN: "Cannot remove the last administrator",
    },
    "config_admin_required": {
        LOCALE_ZH: "该操作需要管理员权限",
        LOCALE_EN: "This operation requires administrator privileges",
    },
    "repository_already_watching": {
        LOCALE_ZH: "已关注该仓库",
        LOCALE_EN: "You are already watching this repository",
    },
    "repository_not_watching": {
        LOCALE_ZH: "未关注该仓库",
        LOCALE_EN: "You are not watching this repository",
    },
    "search_query_required": {
        LOCALE_ZH: "搜索关键词不能为空",
        LOCALE_EN: "Search query cannot be empty",
    },

    # =========================================================
    # 文件评论
    # =========================================================
    "comment_content_required": {
        LOCALE_ZH: "评论内容不能为空",
        LOCALE_EN: "Comment content cannot be empty",
    },
    "comment_file_path_required": {
        LOCALE_ZH: "文件路径不能为空",
        LOCALE_EN: "File path cannot be empty",
    },
    "comment_invalid_parent": {
        LOCALE_ZH: "父评论不存在",
        LOCALE_EN: "Parent comment not found",
    },
    "comment_not_found": {
        LOCALE_ZH: "评论不存在",
        LOCALE_EN: "Comment not found",
    },

    # =========================================================
    # 分支 / 合并 / rebase（git_utils 下沉层）
    # =========================================================
    "invalid_branch_name": {
        LOCALE_ZH: "分支名非法",
        LOCALE_EN: "Invalid branch name",
    },
    "invalid_file_path": {
        LOCALE_ZH: "文件路径非法",
        LOCALE_EN: "Invalid file path",
    },
    "invalid_source_path": {
        LOCALE_ZH: "源路径非法",
        LOCALE_EN: "Invalid source path",
    },
    "invalid_destination_path": {
        LOCALE_ZH: "目标路径非法",
        LOCALE_EN: "Invalid destination path",
    },
    "source_destination_same": {
        LOCALE_ZH: "源路径与目标路径相同",
        LOCALE_EN: "Source and destination are the same",
    },
    "only_files_movable": {
        LOCALE_ZH: "只能移动文件",
        LOCALE_EN: "Only files can be moved",
    },
    "merge_conflict_detected": {
        LOCALE_ZH: "存在合并冲突",
        LOCALE_EN: "Merge conflicts detected",
    },
    "merge_base_not_found": {
        LOCALE_ZH: "找不到共同祖先，无法 rebase",
        LOCALE_EN: "Cannot find merge base for rebase",
    },
    "rebase_parent_not_found": {
        LOCALE_ZH: "无法解析 rebase 的父提交",
        LOCALE_EN: "Cannot resolve parent commit for rebase",
    },
    "rebase_commit_not_found": {
        LOCALE_ZH: "无法解析重放后的提交",
        LOCALE_EN: "Failed to resolve replayed commit",
    },
    "fork_no_origin": {
        LOCALE_ZH: "Fork 仓库缺少 origin 远端",
        LOCALE_EN: "Fork repository has no 'origin' remote",
    },

    # =========================================================
    # Pull Request 合并闸门
    # =========================================================
    "pr_merge_override_forbidden": {
        LOCALE_ZH: "只有仓库所有者/管理员可以覆盖分支保护",
        LOCALE_EN: "Only repository owners/admins can override branch protection",
    },
    "pr_merge_requires_review": {
        LOCALE_ZH: "分支保护要求至少一次批准（自批不计）",
        LOCALE_EN: "Branch protection requires at least one approval (self-approval does not count)",
    },
    "pr_merge_status_checks_failed": {
        LOCALE_ZH: "分支保护要求状态检查通过",
        LOCALE_EN: "Branch protection requires status checks to pass",
    },
    "pr_self_approve_forbidden": {
        LOCALE_ZH: "不能批准自己的 Pull Request",
        LOCALE_EN: "Cannot approve your own pull request",
    },

    # =========================================================
    # Git Hook
    # =========================================================
    "git_hook_invalid_secret": {
        LOCALE_ZH: "Git hook 密钥校验失败",
        LOCALE_EN: "Git hook secret verification failed",
    },

    # =========================================================
    # 私聊（DM）
    # =========================================================
    "dm_self_chat_forbidden": {
        LOCALE_ZH: "不能与自己建立私聊会话",
        LOCALE_EN: "Cannot start a direct message with yourself",
    },
    "dm_user_not_found": {
        LOCALE_ZH: "私聊用户不存在",
        LOCALE_EN: "Direct message user not found",
    },

    # =========================================================
    # 协作编辑邀请 / 会话
    # =========================================================
    "collab_invite_dockey_mismatch": {
        LOCALE_ZH: "doc_key 不属于该仓库",
        LOCALE_EN: "doc_key does not belong to this repository",
    },
    "collab_invite_forbidden": {
        LOCALE_ZH: "仅仓库成员可生成协作邀请链接",
        LOCALE_EN: "Only repository members can create collaboration invite links",
    },
    "collab_invite_invalid": {
        LOCALE_ZH: "邀请 token 无效或已过期",
        LOCALE_EN: "Invite token is invalid or expired",
    },
    "collab_invite_revoke_forbidden": {
        LOCALE_ZH: "仅仓库所有者/管理员可撤销协作邀请链接",
        LOCALE_EN: "Only repository owners/admins can revoke collaboration invite links",
    },
    "collab_session_dockey_mismatch": {
        LOCALE_ZH: "doc_key 不属于该仓库",
        LOCALE_EN: "doc_key does not belong to this repository",
    },
    "collab_session_forbidden": {
        LOCALE_ZH: "仅仓库所有者/管理员可管理协作会话权限",
        LOCALE_EN: "Only repository owners/admins can manage collaboration session permissions",
    },
    "collab_session_kicked": {
        LOCALE_ZH: "已被移出协作会话",
        LOCALE_EN: "You have been removed from the collaboration session",
    },

    # =========================================================
    # LFS 凭证 / transfer token
    # =========================================================
    "invalid_basic_auth": {
        LOCALE_ZH: "Basic 认证格式非法",
        LOCALE_EN: "Invalid Basic auth format",
    },
    "missing_credentials": {
        LOCALE_ZH: "缺少用户名或密码",
        LOCALE_EN: "Missing username or password",
    },
    "lfs_token_required": {
        LOCALE_ZH: "需要 LFS 传输令牌",
        LOCALE_EN: "LFS transfer token required",
    },
    "lfs_token_invalid": {
        LOCALE_ZH: "LFS 传输令牌无效或已过期",
        LOCALE_EN: "Invalid or expired LFS token",
    },
    "lfs_token_repo_mismatch": {
        LOCALE_ZH: "该 LFS 令牌不适用于此仓库",
        LOCALE_EN: "This LFS token is not valid for this repository",
    },
    "lfs_token_write_denied": {
        LOCALE_ZH: "该 LFS 令牌没有写入权限",
        LOCALE_EN: "This LFS token does not grant write access",
    },
    "lfs_object_not_found": {
        LOCALE_ZH: "LFS 对象不存在",
        LOCALE_EN: "LFS object not found",
    },
}


def get_error_message(
    error_code: Optional[str],
    locale: str,
    default: Optional[str] = None,
) -> str:
    """
    根据错误码与语言返回本地化错误消息.

    Args:
        error_code: 稳定错误码（不存在时为 None）
        locale: 请求目标语言（已归一化，如 "zh"、"en"）
        default: 未命中错误码时的回退消息（对应原 detail）

    Returns:
        str: 本地化错误消息
    """
    if error_code:
        mapping = ERROR_MESSAGES.get(error_code)
        if mapping:
            return mapping.get(locale, mapping.get(DEFAULT_LOCALE, ""))
    return default or ""


def normalize_locale(accept_language: Optional[str]) -> str:
    """
    从 `Accept-Language` 头解析目标语言（zh/en）.

    Args:
        accept_language: 请求头值，如 "zh-CN,zh;q=0.9,en;q=0.8"

    Returns:
        str: 归一化语言，默认 "zh"
    """
    if not accept_language:
        return DEFAULT_LOCALE

    candidates = [part.split(";")[0].strip().lower() for part in accept_language.split(",")]
    for candidate in candidates:
        base = candidate.split("-")[0]
        if base in SUPPORTED_LOCALES:
            return base
    return DEFAULT_LOCALE