export interface paths {
    "/": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Root
         * @description 根路由 - 欢迎信息
         *
         *     Returns:
         *         dict: 应用基本信息
         */
        get: operations["root__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Health Check
         * @description 健康检查路由
         *
         *     Returns:
         *         dict: 健康状态信息
         */
        get: operations["health_check_health_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Config Endpoint
         * @description 获取应用配置
         *
         *     Args:
         *         section: 配置节名称，如 'server', 'app', 'storage' 等
         *
         *     Returns:
         *         ConfigResponse: 配置数据
         */
        get: operations["get_config_endpoint_api_app_config_get"];
        put?: never;
        /**
         * Update Config Endpoint
         * @description 更新应用配置（写入 ``app_config`` 表；本进程立即生效，其余进程 ≤5s 收敛）
         *
         *     Args:
         *         request: 配置更新请求
         *         current_user: 当前用户（落 ``app_config.updated_by`` 审计）
         *
         *     Returns:
         *         ConfigResponse: 更新结果（包含重启提示）
         */
        post: operations["update_config_endpoint_api_app_config_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/config/reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reset Config Endpoint
         * @description 重置配置为默认值
         *
         *     Returns:
         *         ConfigResponse: 重置结果
         */
        post: operations["reset_config_endpoint_api_app_config_reset_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/config/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Validate Config Endpoint
         * @description 验证配置数据
         *
         *     Args:
         *         config_data: 要验证的配置数据，为空则验证当前配置
         *
         *     Returns:
         *         ConfigResponse: 验证结果
         */
        post: operations["validate_config_endpoint_api_app_config_validate_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/debug": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set Debug Mode Endpoint
         * @description 开启/关闭调试模式（仅管理员）
         *
         *     将 ``app.debug`` 写入 ``app_config``（其余键保留）：本进程立即生效，
         *     其余进程经配置版本检测 ≤5s 收敛——**无需重启服务**。
         *
         *     Returns:
         *         DebugToggleResponse: 切换结果与提示
         */
        post: operations["set_debug_mode_endpoint_api_app_debug_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Status Endpoint
         * @description 获取应用状态（登录可见）
         *
         *     Args:
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         StatusResponse: 应用状态信息
         */
        get: operations["get_status_endpoint_api_app_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/stats/platform": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Platform Stats Endpoint
         * @description 获取平台级公开统计
         *
         *     Returns:
         *         dict: 包含 repository_count, commit_count, user_count, uptime_seconds
         */
        get: operations["get_platform_stats_endpoint_api_v1_stats_platform_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/metrics/timeseries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Metrics Timeseries Endpoint
         * @description 获取概览趋势时序（仅管理员）。
         *
         *     合并请求分钟桶与进程内存/CPU 采样，按范围降采样为点序列。历史存于 Redis
         *     （请求桶见 middleware/request_stats，进程采样见 services/process_metrics），
         *     保留时长由 ``metrics.history_minutes`` 控制；Redis 不可用时退回进程内实现。
         *
         *     Returns:
         *         MetricsTimeseriesResponse: 范围、步长、数据来源与点序列
         */
        get: operations["get_metrics_timeseries_endpoint_api_app_metrics_timeseries_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/shutdown": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Shutdown Endpoint
         * @description 关闭应用
         *
         *     发送信号触发优雅关闭
         *
         *     Returns:
         *         ActionResponse: 操作结果
         */
        post: operations["shutdown_endpoint_api_app_shutdown_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/restart": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restart Endpoint
         * @description 重启应用（管理员；调试模式下仅对本机来源开放）
         *
         *     多 worker 部署下信号交给**进程管理器**（uvicorn ``--workers`` /
         *     gunicorn）做滚动重启——新 worker 就绪后才退役旧 worker；单进程才回退到
         *     「拉起新进程 + 退出自身」。
         *
         *     Returns:
         *         ActionResponse: 操作结果
         */
        post: operations["restart_endpoint_api_app_restart_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Log Info Endpoint
         * @description 获取日志系统信息
         *
         *     Returns:
         *         LogInfoResponse: 日志目录、文件列表等信息
         */
        get: operations["get_log_info_endpoint_api_app_logs_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/logs/content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Log Content Endpoint
         * @description 获取日志内容
         *
         *     Args:
         *         date: 日期字符串，格式 YYYY-MM-DD
         *         log_name: 日志文件名（不含扩展名）
         *         lines: 返回的行数（从末尾开始）
         *         level: 过滤日志级别
         *
         *     Returns:
         *         LogContentResponse: 日志内容和元数据
         */
        get: operations["get_log_content_endpoint_api_app_logs_content_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/logs/cleanup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cleanup Logs Endpoint
         * @description 清理旧日志文件
         *
         *     Args:
         *         keep_days: 保留最近多少天的日志
         *
         *     Returns:
         *         LogCleanupResponse: 清理结果
         */
        post: operations["cleanup_logs_endpoint_api_app_logs_cleanup_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Query Audit Endpoint
         * @description 审计统一查询（；收紧为 **admin-only**）
         *
         *     合并两此前互不相通的审计体系：``audit.log`` 的 HTTP 请求审计与
         *     ``activities`` 表的业务实体审计，按时间倒序统一返回。
         *
         *     原依赖 ``check_app_permission``（debug 或 admin 即放行）——debug 模式
         *     对任意已登录用户开放且无本机来源限制，审计含 client_ip/UA/query 并可
         *     扫 5 万行（debug 误配 = 普通用户读全量审计）。
         */
        get: operations["query_audit_endpoint_api_app_audit_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/components": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Components Endpoint
         * @description 获取编排中各组件（容器）的状态。
         *
         *     通过只读 Docker socket 代理查询，用于 admin 控制台可视化各组件健康度。
         *     仅管理员可访问；Docker 不可用时返回 available=false 而非报错。
         *
         *     Returns:
         *         ComponentsResponse: 组件状态列表与汇总
         */
        get: operations["get_components_endpoint_api_app_components_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/monitoring": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Monitoring Endpoint
         * @description 探测可选监控栈（Prometheus / Grafana）是否在运行。
         *
         *     经只读 docker-socket-proxy 复用编排容器清单判定；Docker 不可用时降级
         *     available=false。Grafana 的 ready 表示容器运行中且已注入凭据，
         *     admin 控制台据此展示「打开 Grafana」入口。
         *
         *     Returns:
         *         MonitoringResponse: 监控栈服务状态
         */
        get: operations["get_monitoring_endpoint_api_app_monitoring_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/monitoring/enabled": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set Monitoring Enabled Endpoint
         * @description 开关可选监控栈（Prometheus / Grafana 一并启停，仅管理员）。
         *
         *     经窄写代理（docker-write-proxy）对监控栈容器做 start/stop；容器需已创建
         *     （曾以监控 compose 部署过一次，之后可被后续一键部署遗漏而停摆），
         *     从未部署过时返回 409 并给出拉起命令。编排不可用或控制失败返回 502。
         *
         *     Returns:
         *         MonitoringResponse: 启停后重新探测的监控栈状态
         */
        post: operations["set_monitoring_enabled_endpoint_api_app_monitoring_enabled_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/monitoring/grafana/sso": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Grafana Sso Endpoint
         * @description Grafana 免密登录（SSO）：以管理员身份在 app 侧登录 Grafana，
         *     取出 ``grafana_session`` 并以同源 Cookie（Path=/grafana）下发给浏览器，
         *     前端随后跳转到网关反代子路径 ``/grafana`` 即可直接进入 Grafana。
         *
         *     仅管理员可访问；Grafana 不可达或凭据无效时返回 502。
         *
         *     Returns:
         *         GrafanaSsoResponse: 登录成功 + 入口路径（前端据此 location.assign）
         */
        get: operations["grafana_sso_endpoint_api_app_monitoring_grafana_sso_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/redis/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Redis Status Endpoint
         * @description 获取 Redis 运维状态（仅管理员，只读）。
         *
         *     聚合连接探活/延迟、各 worker 存活与广播总线状态（Redis 心跳注册表）、
         *     订阅模式数（PUBSUB NUMPAT）、INFO 指标、命名空间键数与降级计数。
         *     Redis 不可用时返回 reachable=false 而非报错。
         *
         *     Returns:
         *         dict: Redis 连接/worker/订阅/指标/键空间/降级
         */
        get: operations["get_redis_status_endpoint_api_app_redis_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/redis/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Redis Config Endpoint
         * @description 获取 Redis 配置（仅管理员，只读；连接 URL 脱敏）。
         *
         *     Returns:
         *         dict: settings（脱敏）/runtime（INFO memory）/editable/source
         */
        get: operations["get_redis_config_endpoint_api_app_redis_config_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/agent/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Agent Config Endpoint
         * @description 读取 Agent 配置（含 meta）
         *
         *     Returns:
         *         dict: ``{config: {...}, meta: {editable_keys, hot_keys, restart_keys,
         *         source, version, writable}}``——``version`` 为 agent 节行版本（PUT 乐观锁凭据）；
         *         key 只存环境变量名，响应无密钥。
         */
        get: operations["get_agent_config_endpoint_api_app_agent_config_get"];
        /**
         * Put Agent Config Endpoint
         * @description 保存 Agent 配置（写入 ``app_config[agent]``；本进程立即生效，其余进程 ≤5s 收敛）
         *
         *     Args:
         *         payload: ``{values, version, api_key?, clear_api_key?}``——version 与
         *             库内行版本不符 → 409 ``agent_config_version_conflict``；键不在白名单
         *             或值超约束 → 422 ``agent_config_invalid``；密钥写入仅限管理员
         *             （``app_admin_required``），密文与配置同事务落库、响应零回显
         *         current_user: 当前用户（落 ``app_config.updated_by``/密钥审计）
         *
         *     Returns:
         *         dict: ``{version, applied: {键: "immediate"}, env_overridden: [...],
         *         key_state: {configured, source}}``
         */
        put: operations["put_agent_config_endpoint_api_app_agent_config_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/agent/providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Agent Providers Endpoint
         * @description 供应商目录（只读常量）
         *
         *     Returns:
         *         dict: ``{providers: [{id, label, base_url, models, key_env, ...}], allow_custom}``
         */
        get: operations["list_agent_providers_endpoint_api_app_agent_providers_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/agent/models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Agent Models Endpoint
         * @description 模型列表（服务端用 env key 代理 ``GET {base_url}/models``，5s 超时）
         *
         *     不接受请求体 key（不进日志、不进 URL）。失败：``agent_key_missing``(400) /
         *     ``agent_base_url_forbidden``(400) / ``agent_models_unavailable``(502，
         *     目录有静态兜底时改回 ``source="static"``)。
         *
         *     Returns:
         *         dict: ``{models: [{id}], source: "remote"|"static", base_url, provider, ...}``
         */
        get: operations["get_agent_models_endpoint_api_app_agent_models_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/agent/test-connection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Test Agent Connection Endpoint
         * @description 连接探测（管理员配置级）
         *
         *     先 ``GET /models``，端点不支持（404/405）则降级 1-token ``/chat/completions``。
         *     连通性结果软失败（``200 + ok=false + error_code``，前端内联渲染）；
         *     仅输入非法（base_url 形态 / 未知 provider）返回 400。
         *
         *     Returns:
         *         dict: ``{ok, base_url, model, latency_ms, checked_at, source?, error_code?, error?}``
         */
        post: operations["test_agent_connection_endpoint_api_app_agent_test_connection_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/agent/key-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Agent Key Status Endpoint
         * @description 密钥状态（只回「有没有」；**永不返回 key 值**）
         *
         *     Returns:
         *         dict: ``{env_name, configured, injection, providers: [{id, key_env, configured, source_env}]}``
         */
        get: operations["get_agent_key_status_endpoint_api_app_agent_key_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/agent/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Agent Usage Endpoint
         * @description 用量聚合（admin 概览图表用；只读，不回显 prompt/result）
         *
         *     Returns:
         *         dict: ``{days, since, daily: [{date, jobs, succeeded, failed, tokens,
         *         avg_duration_s}], totals, tools: [{name, calls}]}``
         */
        get: operations["get_agent_usage_endpoint_api_app_agent_usage_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/search/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Search Config Endpoint
         * @description 读取搜索/embedding 配置（含 meta）
         *
         *     Returns:
         *         dict: ``{config: {...}, meta: {editable_keys, hot_keys, restart_keys,
         *         source, version, writable, key_state}}``——配置模型不含 key 字段，
         *         响应结构上无密钥可回显。
         */
        get: operations["get_search_config_endpoint_api_app_search_config_get"];
        /**
         * Put Search Config Endpoint
         * @description 保存搜索/embedding 配置（写入 ``app_config[search]``；密钥密文落库）
         *
         *     Args:
         *         payload: ``{values, version, embedding_api_key?, clear_embedding_api_key?}``
         *             ——version 不符 → 409 ``search_config_version_conflict``；键/值非法
         *             → 422 ``search_config_invalid``；密钥写入仅限管理员
         *             （``app_admin_required``）
         *         current_user: 当前用户（落审计）
         *
         *     Returns:
         *         dict: ``{version, applied, env_overridden, key_state}``
         */
        put: operations["put_search_config_endpoint_api_app_search_config_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/app/search/index-overview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Search Index Overview Endpoint
         * @description 全实例索引健康度（admin 索引页；只读派生数据）
         *
         *     Returns:
         *         dict: ``{repos: [{id, name, path, head_commit, indexed_commit, in_sync,
         *         chunks, refs, embeddings, last_indexed_at}], totals, semantic_enabled,
         *         current_generation}``
         */
        get: operations["get_search_index_overview_endpoint_api_app_search_index_overview_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/tree": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository Tree
         * @description 获取仓库文件树
         *
         *     Args:
         *         repo_id: 仓库ID
         *         ref: 分支名或提交SHA，默认 HEAD
         *         path: 子目录路径，默认根目录
         *         last_commit: 是否附带每个条目（文件/目录）最近提交信息
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 文件树数据
         *
         *     Raises:
         *         HTTPException: 仓库或路径不存在
         */
        get: operations["get_repository_tree_api_v1_repositories__repo_id__tree_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/blob": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository Blob
         * @description 获取文件内容
         *
         *     Args:
         *         repo_id: 仓库ID
         *         path: 文件路径（必填）
         *         ref: 分支名或提交SHA，默认 HEAD
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 文件内容数据
         *
         *     Raises:
         *         HTTPException: 文件不存在或是目录
         */
        get: operations["get_repository_blob_api_v1_repositories__repo_id__blob_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/contents/{file_path}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Update Repository File
         * @description 在指定分支创建/更新文件并提交 (Editor 保存链路)
         *
         *     空仓库时创建初始提交并建立默认分支
         */
        put: operations["update_repository_file_api_v1_repositories__repo_id__contents__file_path__put"];
        post?: never;
        /**
         * Delete Repository File
         * @description 在指定分支删除文件并提交
         */
        delete: operations["delete_repository_file_api_v1_repositories__repo_id__contents__file_path__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/contents/move": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Move Repository File
         * @description 在指定分支重命名/移动文件并提交 (单次提交内 copy+delete)
         *
         *     目标父目录不存在时自动创建; 目标已存在则返回 409。
         */
        post: operations["move_repository_file_api_v1_repositories__repo_id__contents_move_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/commits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository Commits
         * @description 获取提交历史
         *
         *     Args:
         *         repo_id: 仓库ID
         *         ref: 分支名，默认 HEAD
         *         path: 特定文件路径，None 表示所有提交
         *         page: 页码，默认 1
         *         per_page: 每页数量，默认 30
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 提交历史数据
         *
         *     Raises:
         *         HTTPException: 仓库不存在
         */
        get: operations["get_repository_commits_api_v1_repositories__repo_id__commits_get"];
        put?: never;
        /**
         * Create Commit
         * @description 创建提交记录（需要认证 + 仓库写权限）
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         repo_id: 仓库ID
         *         commit_data: 提交信息
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         Commit: 创建的提交记录
         *
         *     Raises:
         *         ValidationException: 请求参数不完整时抛出422异常
         *         ConflictException: 提交哈希已存在时抛出409异常
         *         NotFoundException: 分支不存在时抛出404异常
         */
        post: operations["create_commit_api_v1_repositories__repo_id__commits_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/diff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository Diff
         * @description 获取代码差异
         *
         *     Args:
         *         repo_id: 仓库ID
         *         head: 对比提交SHA（必填）
         *         base: 基准提交SHA，None 表示与空树对比
         *         path: 特定文件路径，None 表示所有文件
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 差异数据
         *
         *     Raises:
         *         HTTPException: 提交不存在
         */
        get: operations["get_repository_diff_api_v1_repositories__repo_id__diff_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/blame": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository Blame
         * @description 获取文件行级追溯 (Blame)
         *
         *     Args:
         *         repo_id: 仓库ID
         *         path: 文件路径（必填）
         *         ref: 分支名或提交SHA，默认 HEAD
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 按 hunk 聚合的行级作者信息
         *
         *     Raises:
         *         HTTPException: 仓库/引用/文件不存在
         */
        get: operations["get_repository_blame_api_v1_repositories__repo_id__blame_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/graph": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository Graph
         * @description 获取提交图（拓扑序节点 + 父边 + 引用标签）
         *
         *     Args:
         *         repo_id: 仓库ID
         *         ref: 起始引用，默认 HEAD
         *         limit: 最大节点数，默认 100
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 提交图节点列表，由前端据 parents 计算泳道布局
         *
         *     Raises:
         *         HTTPException: 仓库或引用不存在
         */
        get: operations["get_repository_graph_api_v1_repositories__repo_id__graph_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/compare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository Compare
         * @description 对比两个引用（base...head）
         *
         *     Args:
         *         repo_id: 仓库ID
         *         base: 基准引用（必填）
         *         head: 目标引用（必填）
         *         path: 特定文件路径，None 表示所有文件
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 合并基、领先提交数、提交列表与逐文件差异
         *
         *     Raises:
         *         HTTPException: 仓库或引用不存在
         */
        get: operations["get_repository_compare_api_v1_repositories__repo_id__compare_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/readme": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository Readme
         * @description 获取 README 文件内容
         *
         *     自动查找 README.md, README.rst, README.txt, README 等常见 README 文件
         *
         *     Args:
         *         repo_id: 仓库ID
         *         ref: 分支名或提交SHA，默认 HEAD
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: README 文件信息
         *         {
         *             "found": bool,
         *             "filename": str or None,
         *             "content": str or None,
         *             "language": str,
         *             "encoding": str
         *         }
         */
        get: operations["get_repository_readme_api_v1_repositories__repo_id__readme_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/symbols": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository File Symbols
         * @description 获取文件符号（函数、类、变量等）
         *
         *     目前支持 Python 文件的符号提取，其他语言返回空列表
         *
         *     Args:
         *         repo_id: 仓库ID
         *         path: 文件路径（必填）
         *         ref: 分支名或提交SHA，默认 HEAD
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 符号列表
         *         {
         *             "path": str,
         *             "language": str,
         *             "symbols": [
         *                 {
         *                     "name": str,
         *                     "type": str,
         *                     "line": int
         *                 }
         *             ]
         *         }
         */
        get: operations["get_repository_file_symbols_api_v1_repositories__repo_id__symbols_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/language": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Detect Repository File Language
         * @description 检测文件语言类型
         *
         *     Args:
         *         repo_id: 仓库ID
         *         path: 文件路径（必填）
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 语言信息
         *         {
         *             "path": str,
         *             "language": str
         *         }
         */
        get: operations["detect_repository_file_language_api_v1_repositories__repo_id__language_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Login
         * @description 用户登录
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         credentials: 登录凭据（用户名和密码）
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 登录成功信息和用户数据，包含访问令牌
         *
         *     Raises:
         *         ValidationException: 请求参数不完整时抛出422异常
         *         AuthenticationException: 用户名或密码错误时抛出401异常
         *
         *     Example:
         *         ```json
         *         {
         *             "username": "admin",
         *             "password": "password123"
         *         }
         *         ```
         */
        post: operations["login_api_v1_auth_login_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Refresh Token
         * @description 刷新访问令牌（带轮换与重用检测）
         *
         *     旧 refresh 换发新对后被标记已轮换；宽限期内重放放行（多标签页
         *     竞态），超宽限重放触发 family 吊销——详见
         *     ``token_service.refresh_access_token``。
         *
         *     Args:
         *         request: 刷新令牌请求
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 新的访问令牌和刷新令牌
         *
         *     Raises:
         *         AuthenticationException: 令牌无效/已撤销/重用，或用户不存在/未激活（401）
         *
         *     Example:
         *         ```json
         *         {
         *             "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
         *         }
         *         ```
         *
         *     Response:
         *         ```json
         *         {
         *             "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
         *             "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
         *             "token_type": "bearer"
         *         }
         *         ```
         */
        post: operations["refresh_token_api_v1_auth_refresh_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Logout
         * @description 登出：将当前访问令牌（及可选刷新令牌）加入撤销黑名单，立即失效；
         *     并吊销整个 refresh family——同一次登录会话派生的全部
         *     refresh 换链（含已轮换出去、其它标签页持有的）一并失效。
         *
         *     Args:
         *         body: 可选请求体，携带 refresh_token 时一并撤销
         *         credentials: Authorization 头中的访问令牌
         *         current_user: 当前认证用户
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: {"success": True, "access_revoked": bool, "refresh_revoked": bool,
         *                "family_revoked": bool}
         */
        post: operations["logout_api_v1_auth_logout_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/collab/auth": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Collab Auth
         * @description 连接鉴权 (网关 onAuthenticate 回调)
         *
         *     Returns:
         *         user_id, username, can_write, repository_id, branch, path
         */
        post: operations["collab_auth_api_v1_collab_auth_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/collab/doc": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Collab Doc
         * @description 文档加载 (网关 onLoadDocument 回调)
         *
         *     Returns:
         *         {content, branch, path}; 二进制文件 415; 文件不存在 404
         */
        get: operations["collab_doc_api_v1_collab_doc_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/collab/save": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Collab Save
         * @description 协作保存 (网关 onStateless 触发): 以提交者身份写入 Git commit
         *
         *     每次保存实时校验写权限, 返回 commit_id 供网关向会话广播。
         */
        post: operations["collab_save_api_v1_collab_save_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/git-internal/pre-receive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Pre Receive
         * @description 推送前回调：保护分支 + 大小上限裁决。非 2xx 时 hook 拒绝本次推送。
         */
        post: operations["pre_receive_api_v1_git_internal_pre_receive_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/git-internal/post-receive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Post Receive
         * @description 推送后回调：分支对账 + 提交入库 + webhook。失败由 hook 记日志，下推自愈。
         */
        post: operations["post_receive_api_v1_git_internal_post_receive_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/{provider}/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Oauth Login */
        get: operations["oauth_login_api_v1_auth__provider__login_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/{provider}/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Oauth Callback */
        get: operations["oauth_callback_api_v1_auth__provider__callback_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me/oauth": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Linked Accounts */
        get: operations["list_linked_accounts_api_v1_users_me_oauth_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me/oauth/{provider}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Unlink Account */
        delete: operations["unlink_account_api_v1_users_me_oauth__provider__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 获取所有用户
         * @description 获取所有用户（需要认证）
         *
         *     Args:
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         list[User]: 用户列表
         */
        get: operations["get_users_api_v1_users_get"];
        put?: never;
        /**
         * 创建新用户
         * @description 创建新用户（**自助注册入口**，决策确认为有意开放）
         *
         *     无认证属设计而非缺陷：这是注册端点（wiki 05 口径），用户由此自助开户。
         *     因此「全站可注册」是仓库可见性/权限口径的前置假设——公开仓的读与
         *     参与型写（issue/PR/评论）以「已认证」为门槛，注册即获得该门槛。
         *
         *     Args:
         *         user_data: 用户创建数据，包含用户名、邮箱、密码等
         *         db: 数据库会话
         *
         *     Returns:
         *         User: 创建的用户信息
         *
         *     Raises:
         *         ConflictException: 用户名或邮箱已存在时抛出409异常
         *         ValidationException: 请求参数无效时抛出422异常
         */
        post: operations["create_user_api_v1_users_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 获取当前用户信息
         * @description 获取当前登录用户信息
         *
         *     Args:
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         User: 当前用户信息（user_to_dict 序列化，排除 password 等敏感字段）
         */
        get: operations["get_current_user_info_api_v1_users_me_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me/dashboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 获取当前用户 Dashboard
         * @description 获取当前登录用户的 Dashboard 聚合数据
         *
         *     Args:
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: Dashboard 数据
         */
        get: operations["get_current_user_dashboard_api_v1_users_me_dashboard_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me/pull-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 获取当前用户的跨仓库 PR 列表
         * @description 获取当前登录用户相关的跨仓库 Pull Request 列表
         *
         *     Args:
         *         status: 状态筛选（open/merged/closed）
         *         page: 页码
         *         limit: 每页数量
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 分页 PR 列表
         */
        get: operations["get_current_user_pull_requests_api_v1_users_me_pull_requests_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me/issues": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 获取当前用户的跨仓库 Issue 列表
         * @description 获取当前登录用户相关的跨仓库 Issue 列表
         *
         *     Args:
         *         status: 状态筛选（open/closed）
         *         page: 页码
         *         limit: 每页数量
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 分页 Issue 列表
         */
        get: operations["get_current_user_issues_api_v1_users_me_issues_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me/review-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 获取待当前用户审阅的 PR 列表
         * @description 获取待当前用户审阅的开放 PR 列表（dashboard 卡片数据源）
         *
         *     Args:
         *         limit: 返回条数
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         list: PR 摘要列表
         */
        get: operations["get_current_user_review_requests_api_v1_users_me_review_requests_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me/builds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 获取当前用户可访问仓库的最近构建
         * @description 获取当前用户可访问仓库的最近构建记录（dashboard 卡片数据源）
         *
         *     Args:
         *         limit: 返回条数
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         list: 构建记录列表
         */
        get: operations["get_current_user_builds_api_v1_users_me_builds_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me/contributors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 获取近 N 天贡献者排行
         * @description 获取近 N 天可访问仓库的贡献者排行（dashboard 卡片数据源）
         *
         *     Args:
         *         days: 统计窗口天数
         *         limit: 返回条数
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         list: 贡献者列表（用户名 + 活动数）
         */
        get: operations["get_current_user_contributors_api_v1_users_me_contributors_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 修改当前用户密码
         * @description 修改当前登录用户的密码
         *
         *     Args:
         *         data: 密码修改数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 操作成功消息
         */
        post: operations["change_current_user_password_api_v1_users_me_password_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me/avatar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 上传当前用户头像
         * @description 上传当前登录用户的头像
         *
         *     Args:
         *         file: 头像图片文件
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 更新后的用户信息，包含 avatar_url
         *
         *     Raises:
         *         ValidationException: 文件格式或大小不符合要求
         */
        post: operations["upload_current_user_avatar_api_v1_users_me_avatar_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{user_id}/avatar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 获取用户头像
         * @description 获取用户头像文件
         *
         *     Args:
         *         user_id: 用户ID
         *
         *     Returns:
         *         FileResponse: 头像图片文件
         *
         *     Raises:
         *         NotFoundException: 头像不存在
         */
        get: operations["get_user_avatar_file_api_v1_users__user_id__avatar_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 根据ID获取用户
         * @description 根据ID获取用户（需要认证）
         *
         *     Args:
         *         user_id: 用户ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         User: 用户信息
         *
         *     Raises:
         *         NotFoundException: 用户不存在时抛出404异常
         */
        get: operations["get_user_api_v1_users__user_id__get"];
        /**
         * Update User
         * @description 更新用户信息（需要认证）
         *
         *     权限规则：
         *     - 普通用户只能更新自己的信息
         *     - 管理员可以更新任何用户的信息
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         user_id: 用户ID
         *         user_data: 更新的用户数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         User: 更新后的用户信息
         *
         *     Raises:
         *         NotFoundException: 用户不存在时抛出404异常
         *         AuthorizationException: 无权限时抛出403异常
         */
        put: operations["update_user_api_v1_users__user_id__put"];
        post?: never;
        /**
         * Delete User
         * @description 删除用户（需要管理员权限）
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         user_id: 用户ID
         *         db: 数据库会话
         *         current_user: 当前认证管理员用户
         *
         *     Returns:
         *         dict: 删除成功消息
         *
         *     Raises:
         *         NotFoundException: 用户不存在时抛出404异常
         *         AuthorizationException: 非管理员时抛出403异常
         */
        delete: operations["delete_user_api_v1_users__user_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{user_id}/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 管理员重置用户密码
         * @description 管理员重置指定用户的密码（不需要旧密码）
         *
         *     Args:
         *         user_id: 用户ID
         *         data: 新密码
         *         db: 数据库会话
         *         current_user: 当前认证管理员用户
         *
         *     Returns:
         *         dict: 重置成功消息
         *
         *     Raises:
         *         AuthorizationException: 非管理员时抛出403异常
         *         NotFoundException: 用户不存在时抛出404异常
         */
        post: operations["admin_reset_user_password_api_v1_users__user_id__password_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository Members
         * @description 获取仓库的所有成员
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         list[RepositoryMember]: 仓库成员列表
         */
        get: operations["get_repository_members_api_v1_repositories__repo_id__members_get"];
        put?: never;
        /**
         * Add Repository Member
         * @description 添加仓库成员
         *
         *     Args:
         *         repo_id: 仓库ID
         *         member_data: 成员信息
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         RepositoryMember: 添加的成员信息
         *
         *     Raises:
         *         ValidationException: 请求参数不完整时抛出422异常
         *         ConflictException: 成员已存在时抛出409异常
         *         NotFoundException: 用户不存在时抛出404异常
         */
        post: operations["add_repository_member_api_v1_repositories__repo_id__members_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/members/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository Member
         * @description 获取仓库的特定成员
         *
         *     Args:
         *         repo_id: 仓库ID
         *         user_id: 用户ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         RepositoryMember: 仓库成员信息
         *
         *     Raises:
         *         NotFoundException: 成员不存在时抛出404异常
         */
        get: operations["get_repository_member_api_v1_repositories__repo_id__members__user_id__get"];
        /**
         * Update Repository Member
         * @description 更新仓库成员信息
         *
         *     Args:
         *         repo_id: 仓库ID
         *         user_id: 用户ID
         *         member_data: 更新的成员信息
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         RepositoryMember: 更新后的成员信息
         *
         *     Raises:
         *         NotFoundException: 成员不存在时抛出404异常
         */
        put: operations["update_repository_member_api_v1_repositories__repo_id__members__user_id__put"];
        post?: never;
        /**
         * Remove Repository Member
         * @description 移除仓库成员
         *
         *     Args:
         *         repo_id: 仓库ID
         *         user_id: 用户ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 移除成功消息
         *
         *     Raises:
         *         NotFoundException: 成员不存在时抛出404异常
         */
        delete: operations["remove_repository_member_api_v1_repositories__repo_id__members__user_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/members/{user_id}/role": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Update Member Role
         * @description 更新成员角色
         *
         *     Args:
         *         repo_id: 仓库ID
         *         user_id: 用户ID
         *         role_data: 角色信息
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         RepositoryMember: 更新后的成员信息
         *
         *     Raises:
         *         NotFoundException: 成员不存在时抛出404异常
         *         ValidationException: 角色无效时抛出422异常
         */
        put: operations["update_member_role_api_v1_repositories__repo_id__members__user_id__role_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/members/{user_id}/activate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Activate Repository Member
         * @description 激活仓库成员
         *
         *     Args:
         *         repo_id: 仓库ID
         *         user_id: 用户ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         RepositoryMember: 更新后的成员信息
         *
         *     Raises:
         *         NotFoundException: 成员不存在时抛出404异常
         */
        put: operations["activate_repository_member_api_v1_repositories__repo_id__members__user_id__activate_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/members/{user_id}/deactivate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Deactivate Repository Member
         * @description 停用仓库成员
         *
         *     Args:
         *         repo_id: 仓库ID
         *         user_id: 用户ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         RepositoryMember: 更新后的成员信息
         *
         *     Raises:
         *         NotFoundException: 成员不存在时抛出404异常
         *         AuthorizationException: 无法停用仓库所有者时抛出403异常
         */
        put: operations["deactivate_repository_member_api_v1_repositories__repo_id__members__user_id__deactivate_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/members/{user_id}/permission": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Check Member Permission
         * @description 检查成员权限
         *
         *     Args:
         *         repo_id: 仓库ID
         *         user_id: 用户ID
         *         permission: 权限名称
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 权限检查结果
         *
         *     Raises:
         *         NotFoundException: 成员不存在时抛出404异常
         */
        get: operations["check_member_permission_api_v1_repositories__repo_id__members__user_id__permission_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/forks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Repository Forks
         * @description 获取仓库的 Fork 列表
         *
         *     Args:
         *         repo_id: 仓库ID
         *         page: 页码
         *         limit: 每页数量
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: Fork 列表和分页信息
         */
        get: operations["list_repository_forks_api_v1_repositories__repo_id__forks_get"];
        put?: never;
        /**
         * Fork Repository
         * @description Fork 仓库
         *
         *     创建源仓库的副本，包括 Git 仓库和所有数据
         *
         *     Args:
         *         repo_id: 源仓库ID
         *         data: Fork 创建数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 创建的 Fork 仓库信息
         */
        post: operations["fork_repository_api_v1_repositories__repo_id__forks_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/forks/source": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Fork Source
         * @description 获取 Fork 的源仓库
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 源仓库信息，如果不是 Fork 则返回 None
         */
        get: operations["get_fork_source_api_v1_repositories__repo_id__forks_source_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/forks/sync": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sync Fork
         * @description 同步 Fork 仓库
         *
         *     从源仓库拉取最新更改
         *
         *     Args:
         *         repo_id: Fork 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 同步结果
         */
        post: operations["sync_fork_api_v1_repositories__repo_id__forks_sync_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/star": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Star Status
         * @description 获取当前用户对仓库的 Star 状态
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: Star 状态和数量
         */
        get: operations["get_star_status_api_v1_repositories__repo_id__star_get"];
        put?: never;
        /**
         * Star Repository
         * @description Star 仓库
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: Star 操作结果
         */
        post: operations["star_repository_api_v1_repositories__repo_id__star_post"];
        /**
         * Unstar Repository
         * @description 取消 Star 仓库
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 取消 Star 操作结果
         */
        delete: operations["unstar_repository_api_v1_repositories__repo_id__star_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/stargazers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Stargazers
         * @description 获取仓库的 Stargazer 列表
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         list: Stargazer 列表
         */
        get: operations["get_stargazers_api_v1_repositories__repo_id__stargazers_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/watch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Watch Status
         * @description 获取当前用户对仓库的关注状态
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 关注状态和数量
         */
        get: operations["get_watch_status_api_v1_repositories__repo_id__watch_get"];
        put?: never;
        /**
         * Watch Repository
         * @description 关注仓库
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 关注操作结果
         */
        post: operations["watch_repository_api_v1_repositories__repo_id__watch_post"];
        /**
         * Unwatch Repository
         * @description 取消关注仓库
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 取消关注操作结果
         */
        delete: operations["unwatch_repository_api_v1_repositories__repo_id__watch_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/watchers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Watchers
         * @description 获取仓库的 Watcher 列表
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         list: Watcher 列表
         */
        get: operations["get_watchers_api_v1_repositories__repo_id__watchers_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/collab/invites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Issue Collab Invite
         * @description 签发协作会话邀请链接 (仅仓库成员)
         *
         *     被邀请人凭 token 获得会话级临时权限 (绑定 docKey + read/write 档位 + 过期时间)。
         */
        post: operations["issue_collab_invite_api_v1_repositories__repo_id__collab_invites_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/collab/invites/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Revoke Collab Invite
         * @description 撤销协作邀请链接 (仅仓库所有者/管理员)
         *
         *     被撤销的 token 立即失效: `/collab/auth` 与 `/collab/save` 将拒绝其换取权限。
         */
        post: operations["revoke_collab_invite_api_v1_repositories__repo_id__collab_invites_revoke_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/collab/sessions/permission": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set Session Permission
         * @description 改成员权限 / 清空覆盖（scope=null）。
         */
        post: operations["set_session_permission_api_v1_repositories__repo_id__collab_sessions_permission_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/collab/sessions/kick": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Kick Session Member
         * @description 踢出成员：即时拒绝其后续鉴权与保存。
         */
        post: operations["kick_session_member_api_v1_repositories__repo_id__collab_sessions_kick_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/labels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Labels */
        get: operations["get_labels_api_v1_repositories__repo_id__labels_get"];
        put?: never;
        /** Create Label */
        post: operations["create_label_api_v1_repositories__repo_id__labels_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/labels/{label_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update Label */
        put: operations["update_label_api_v1_repositories__repo_id__labels__label_id__put"];
        post?: never;
        /** Delete Label */
        delete: operations["delete_label_api_v1_repositories__repo_id__labels__label_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/labels/{label_id}/add": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Add Label To Repository */
        post: operations["add_label_to_repository_api_v1_repositories__repo_id__labels__label_id__add_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/labels/{label_id}/remove": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Remove Label From Repository */
        post: operations["remove_label_from_repository_api_v1_repositories__repo_id__labels__label_id__remove_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/discussions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Discussion Comments */
        get: operations["get_discussion_comments_api_v1_repositories__repo_id__discussions_get"];
        put?: never;
        /** Create Discussion Comment */
        post: operations["create_discussion_comment_api_v1_repositories__repo_id__discussions_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/discussions/{comment_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove Discussion Comment */
        delete: operations["remove_discussion_comment_api_v1_repositories__repo_id__discussions__comment_id__delete"];
        options?: never;
        head?: never;
        /** Resolve Discussion Comment */
        patch: operations["resolve_discussion_comment_api_v1_repositories__repo_id__discussions__comment_id__patch"];
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/lfs/objects/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Batch
         * @description LFS 批量操作（repo_id 寻址；唯一接受用户凭证的入口）
         */
        post: operations["batch_api_v1_repositories__repo_id__lfs_objects_batch_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/lfs/objects/{oid}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Download Object
         * @description 下载 LFS 对象（只接受 LFS transfer token）
         */
        get: operations["download_object_api_v1_repositories__repo_id__lfs_objects__oid__get"];
        /**
         * Upload Object
         * @description 上传 LFS 对象（只接受 LFS transfer token）
         */
        put: operations["upload_object_api_v1_repositories__repo_id__lfs_objects__oid__put"];
        post?: never;
        /**
         * Delete Object
         * @description 删除 LFS 对象（只接受 LFS transfer token）
         */
        delete: operations["delete_object_api_v1_repositories__repo_id__lfs_objects__oid__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/lfs/objects/{oid}/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Verify Object
         * @description 上传完成校验（LFS verify 动作；对象缺失 404、大小不符 400）
         */
        post: operations["verify_object_api_v1_repositories__repo_id__lfs_objects__oid__verify_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/lfs/{owner}/{repo_name}/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Batch By Path
         * @description LFS 批量操作（owner/repo 寻址，供 git-lfs 经网关重写调用）
         */
        post: operations["batch_by_path_api_v1_lfs__owner___repo_name__batch_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/branches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Branches
         * @description 获取仓库的所有分支（需要认证）
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         list[Branch]: 分支列表
         */
        get: operations["get_branches_api_v1_repositories__repo_id__branches_get"];
        put?: never;
        /**
         * Create Branch
         * @description 创建新分支（需要认证）
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         repo_id: 仓库ID
         *         branch_data: 分支信息
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         Branch: 创建的分支信息
         *
         *     Raises:
         *         ValidationException: 请求参数不完整时抛出422异常
         *         ConflictException: 分支名称已存在时抛出409异常
         */
        post: operations["create_branch_api_v1_repositories__repo_id__branches_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/branches/default": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Default Branch
         * @description 获取默认分支
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *
         *     Returns:
         *         Branch: 默认分支信息
         *
         *     Raises:
         *         NotFoundException: 没有默认分支时抛出404异常
         */
        get: operations["get_default_branch_api_v1_repositories__repo_id__branches_default_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/branches/{branch_name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Branch
         * @description 获取仓库的特定分支
         *
         *     Args:
         *         repo_id: 仓库ID
         *         branch_name: 分支名称
         *         db: 数据库会话
         *
         *     Returns:
         *         Branch: 分支信息
         *
         *     Raises:
         *         NotFoundException: 分支不存在时抛出404异常
         */
        get: operations["get_branch_api_v1_repositories__repo_id__branches__branch_name__get"];
        /**
         * Update Branch
         * @description 更新分支信息（需要认证）
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         repo_id: 仓库ID
         *         branch_name: 分支名称
         *         branch_data: 更新的分支信息
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         Branch: 更新后的分支信息
         *
         *     Raises:
         *         NotFoundException: 分支不存在时抛出404异常
         */
        put: operations["update_branch_api_v1_repositories__repo_id__branches__branch_name__put"];
        post?: never;
        /**
         * Delete Branch
         * @description 删除分支（需要认证）
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         repo_id: 仓库ID
         *         branch_name: 分支名称
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 删除成功消息
         *
         *     Raises:
         *         NotFoundException: 分支不存在时抛出404异常
         *         ConflictException: 尝试删除默认分支时抛出409异常
         */
        delete: operations["delete_branch_api_v1_repositories__repo_id__branches__branch_name__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/branches/{branch_name}/default": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set Default Branch
         * @description 设置默认分支（需要认证）
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         repo_id: 仓库ID
         *         branch_name: 分支名称
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 设置成功消息
         *
         *     Raises:
         *         NotFoundException: 分支不存在时抛出404异常
         */
        put: operations["set_default_branch_api_v1_repositories__repo_id__branches__branch_name__default_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/branches/{branch_name}/protect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Protect Branch
         * @description 保护分支（需要认证）
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         repo_id: 仓库ID
         *         branch_name: 分支名称
         *         protection_settings: 保护设置（可选）
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         Branch: 更新后的分支信息
         *
         *     Raises:
         *         NotFoundException: 分支不存在时抛出404异常
         */
        put: operations["protect_branch_api_v1_repositories__repo_id__branches__branch_name__protect_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/branches/{branch_name}/unprotect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Unprotect Branch
         * @description 取消分支保护（需要认证）
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         repo_id: 仓库ID
         *         branch_name: 分支名称
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         Branch: 更新后的分支信息
         *
         *     Raises:
         *         NotFoundException: 分支不存在时抛出404异常
         */
        put: operations["unprotect_branch_api_v1_repositories__repo_id__branches__branch_name__unprotect_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/branches/{branch_name}/protection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Check Branch Protection
         * @description 检查分支是否受保护（需要认证）
         *
         *     Args:
         *         repo_id: 仓库ID
         *         branch_name: 分支名称
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 分支保护状态
         *
         *     Raises:
         *         NotFoundException: 分支不存在时抛出404异常
         */
        get: operations["check_branch_protection_api_v1_repositories__repo_id__branches__branch_name__protection_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/commits/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Commit History
         * @description 获取仓库的提交历史树
         *
         *     Args:
         *         repo_id: 仓库ID
         *         branch_name: 分支名称（可选，默认获取所有分支）
         *         limit: 返回记录数量限制（默认50，最大100）
         *         db: 数据库会话
         *
         *     Returns:
         *         list[Commit]: 提交历史列表
         */
        get: operations["get_commit_history_api_v1_repositories__repo_id__commits_history_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/commits/count": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Count Repo Commits
         * @description 统计仓库的提交数量
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 提交数量统计
         */
        get: operations["count_repo_commits_api_v1_repositories__repo_id__commits_count_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/commits/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search Commits
         * @description 搜索提交记录
         *
         *     Args:
         *         repo_id: 仓库ID
         *         query: 搜索关键词
         *         limit: 返回记录数量限制（默认50，最大100）
         *         db: 数据库会话
         *
         *     Returns:
         *         list[Commit]: 匹配的提交记录列表
         */
        get: operations["search_commits_api_v1_repositories__repo_id__commits_search_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/commits/author": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Commits By Author
         * @description 根据作者邮箱获取提交记录
         *
         *     Args:
         *         repo_id: 仓库ID
         *         author_email: 作者邮箱
         *         limit: 返回记录数量限制（默认50，最大100）
         *         db: 数据库会话
         *
         *     Returns:
         *         list[Commit]: 提交记录列表
         */
        get: operations["get_commits_by_author_api_v1_repositories__repo_id__commits_author_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/commits/latest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Latest Commit
         * @description 获取仓库的最新提交
         *
         *     Args:
         *         repo_id: 仓库ID
         *         branch_name: 分支名称（可选，默认获取所有分支的最新提交）
         *         db: 数据库会话
         *
         *     Returns:
         *         Commit: 最新提交记录
         *
         *     Raises:
         *         NotFoundException: 没有提交记录时抛出404异常
         */
        get: operations["get_latest_commit_api_v1_repositories__repo_id__commits_latest_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/commits/{commit_hash}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Commit By Hash
         * @description 根据提交哈希获取提交详情
         *
         *     Args:
         *         repo_id: 仓库ID
         *         commit_hash: 提交哈希值
         *         db: 数据库会话
         *
         *     Returns:
         *         Commit: 提交详情
         *
         *     Raises:
         *         NotFoundException: 提交不存在时抛出404异常
         */
        get: operations["get_commit_by_hash_api_v1_repositories__repo_id__commits__commit_hash__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/branches/{branch_name}/commits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Branch Commits
         * @description 获取特定分支的提交记录
         *
         *     Args:
         *         repo_id: 仓库ID
         *         branch_name: 分支名称
         *         limit: 返回记录数量限制（默认100，最大1000）
         *         offset: 记录偏移量（默认0）
         *         db: 数据库会话
         *
         *     Returns:
         *         list[Commit]: 提交记录列表
         *
         *     Raises:
         *         NotFoundException: 分支不存在时抛出404异常
         */
        get: operations["get_branch_commits_api_v1_repositories__repo_id__branches__branch_name__commits_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/branches/{branch_name}/commits/count": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Count Branch Commits
         * @description 统计特定分支的提交数量
         *
         *     Args:
         *         repo_id: 仓库ID
         *         branch_name: 分支名称
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: 提交数量统计
         *
         *     Raises:
         *         NotFoundException: 分支不存在时抛出404异常
         */
        get: operations["count_branch_commits_api_v1_repositories__repo_id__branches__branch_name__commits_count_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Repository Tags
         * @description 获取标签列表
         *
         *     Args:
         *         repo_id: 仓库ID
         *         pattern: 可选的 glob 过滤
         *         db: 数据库会话
         *
         *     Returns:
         *         list: [{"name", "message", "commit_hash"}]
         *
         *     Raises:
         *         HTTPException: 仓库不存在
         */
        get: operations["list_repository_tags_api_v1_repositories__repo_id__tags_get"];
        put?: never;
        /**
         * Create Repository Tag
         * @description 创建标签（需要认证）
         *
         *     target 缺省时指向当前 HEAD；message 为空创建轻量标签，否则创建附注标签。
         *
         *     Returns:
         *         dict: 创建的标签信息
         */
        post: operations["create_repository_tag_api_v1_repositories__repo_id__tags_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/tags/{tag_name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository Tag
         * @description 获取单个标签信息，不存在返回 404
         */
        get: operations["get_repository_tag_api_v1_repositories__repo_id__tags__tag_name__get"];
        put?: never;
        post?: never;
        /**
         * Delete Repository Tag
         * @description 删除标签（需要认证，不存在则忽略）
         */
        delete: operations["delete_repository_tag_api_v1_repositories__repo_id__tags__tag_name__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Pull Requests
         * @description 获取 PR 列表
         *
         *     Args:
         *         repo_id: 仓库ID
         *         status: 状态筛选
         *         author: 作者ID筛选
         *         page: 页码
         *         limit: 每页数量
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: PR 列表和分页信息
         */
        get: operations["list_pull_requests_api_v1_repositories__repo_id__pull_requests_get"];
        put?: never;
        /**
         * Create Pull Request
         * @description 创建 Pull Request
         *
         *     Args:
         *         repo_id: 仓库ID
         *         data: PR 创建数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 创建的 PR 数据
         */
        post: operations["create_pull_request_api_v1_repositories__repo_id__pull_requests_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Pull Request
         * @description 获取 PR 详情
         *
         *     Args:
         *         repo_id: 仓库ID
         *         pr_number: PR 编号
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: PR 详情（包含评论和审查）
         */
        get: operations["get_pull_request_api_v1_repositories__repo_id__pull_requests__pr_number__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update Pull Request
         * @description 更新 Pull Request
         *
         *     Args:
         *         repo_id: 仓库ID
         *         pr_number: PR 编号
         *         data: 更新数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 更新后的 PR 数据
         */
        patch: operations["update_pull_request_api_v1_repositories__repo_id__pull_requests__pr_number__patch"];
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Close Pull Request
         * @description 关闭 Pull Request
         *
         *     Args:
         *         repo_id: 仓库ID
         *         pr_number: PR 编号
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 更新后的 PR 数据
         */
        post: operations["close_pull_request_api_v1_repositories__repo_id__pull_requests__pr_number__close_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/merge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Merge Pull Request
         * @description 合并 Pull Request
         *
         *     Args:
         *         repo_id: 仓库ID
         *         pr_number: PR 编号
         *         data: 合并请求数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 更新后的 PR 数据
         */
        post: operations["merge_pull_request_api_v1_repositories__repo_id__pull_requests__pr_number__merge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/comments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Pr Comments
         * @description 获取 PR 评论列表
         *
         *     Args:
         *         repo_id: 仓库ID
         *         pr_number: PR 编号
         *         db: 数据库会话
         *
         *     Returns:
         *         list: 评论列表
         */
        get: operations["list_pr_comments_api_v1_repositories__repo_id__pull_requests__pr_number__comments_get"];
        put?: never;
        /**
         * Create Pr Comment
         * @description 创建 PR 评论
         *
         *     Args:
         *         repo_id: 仓库ID
         *         pr_number: PR 编号
         *         data: 评论数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 创建的评论数据
         */
        post: operations["create_pr_comment_api_v1_repositories__repo_id__pull_requests__pr_number__comments_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/reviews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create Pr Review
         * @description 创建 PR 审查
         *
         *     Args:
         *         repo_id: 仓库ID
         *         pr_number: PR 编号
         *         data: 审查数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 创建的审查数据
         */
        post: operations["create_pr_review_api_v1_repositories__repo_id__pull_requests__pr_number__reviews_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/diff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Pr Diff
         * @description 获取 PR 的整体 diff（文本 + 文件列表 + 统计）
         *
         *     Args:
         *         repo_id: 仓库ID
         *         pr_number: PR 编号
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: {diff, files, stats, base_commit, head_commit}
         */
        get: operations["get_pr_diff_api_v1_repositories__repo_id__pull_requests__pr_number__diff_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/diff/{file_path}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Pr File Diff
         * @description 获取 PR 中单个文件的 diff
         *
         *     Args:
         *         repo_id: 仓库ID
         *         pr_number: PR 编号
         *         file_path: 文件路径
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: {file_path, diff, base_commit, head_commit}
         */
        get: operations["get_pr_file_diff_api_v1_repositories__repo_id__pull_requests__pr_number__diff__file_path__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/issues": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Pr Linked Issues
         * @description 列出该 PR 关联的 Issue。
         */
        get: operations["list_pr_linked_issues_api_v1_repositories__repo_id__pull_requests__pr_number__issues_get"];
        put?: never;
        /**
         * Link Pr Issue
         * @description 把同仓库的 Issue 关联到该 PR（幂等）。
         */
        post: operations["link_pr_issue_api_v1_repositories__repo_id__pull_requests__pr_number__issues_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/issues/{issue_number}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Unlink Pr Issue
         * @description 解除该 PR 与 Issue 的关联。
         */
        delete: operations["unlink_pr_issue_api_v1_repositories__repo_id__pull_requests__pr_number__issues__issue_number__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/reviewers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Pr Reviewers
         * @description 列出被请求的评审人，state 由已提交的评审推导。
         */
        get: operations["list_pr_reviewers_api_v1_repositories__repo_id__pull_requests__pr_number__reviewers_get"];
        put?: never;
        /**
         * Request Pr Reviewers
         * @description 请求一个或多个仓库成员评审该 PR（重复请求幂等）。
         */
        post: operations["request_pr_reviewers_api_v1_repositories__repo_id__pull_requests__pr_number__reviewers_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/reviewers/{reviewer_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Remove Pr Reviewer
         * @description 撤回评审请求（已提交的评审记录不受影响）。
         */
        delete: operations["remove_pr_reviewer_api_v1_repositories__repo_id__pull_requests__pr_number__reviewers__reviewer_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pr-labels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Labels */
        get: operations["get_labels_api_v1_repositories__repo_id__pr_labels_get"];
        put?: never;
        /** Create Label */
        post: operations["create_label_api_v1_repositories__repo_id__pr_labels_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pr-labels/{label_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update Label */
        put: operations["update_label_api_v1_repositories__repo_id__pr_labels__label_id__put"];
        post?: never;
        /** Delete Label */
        delete: operations["delete_label_api_v1_repositories__repo_id__pr_labels__label_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/labels/{label_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add Label To Pr
         * @description 为指定仓库的 PR 添加标签
         *
         *     Args:
         *         repo_id: 仓库ID
         *         pr_number: PR 编号
         *         label_id: 标签ID
         */
        post: operations["add_label_to_pr_api_v1_repositories__repo_id__pull_requests__pr_number__labels__label_id__post"];
        /**
         * Remove Label From Pr
         * @description 从指定仓库的 PR 移除标签
         *
         *     Args:
         *         repo_id: 仓库ID
         *         pr_number: PR 编号
         *         label_id: 标签ID
         */
        delete: operations["remove_label_from_pr_api_v1_repositories__repo_id__pull_requests__pr_number__labels__label_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/pr-labels/{label_id}/pull-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Prs By Label */
        get: operations["get_prs_by_label_api_v1_repositories_pr_labels__label_id__pull_requests_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/releases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Releases
         * @description 获取 Release 列表
         *
         *     Args:
         *         repo_id: 仓库ID
         *         include_drafts: 是否包含草稿
         *         include_prereleases: 是否包含预发布版本
         *         page: 页码
         *         limit: 每页数量
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: Release 列表和分页信息
         */
        get: operations["list_releases_api_v1_repositories__repo_id__releases_get"];
        put?: never;
        /**
         * Create Release
         * @description 创建 Release
         *
         *     Args:
         *         repo_id: 仓库ID
         *         data: Release 创建数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 创建的 Release 数据
         */
        post: operations["create_release_api_v1_repositories__repo_id__releases_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/releases/{release_number}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Release
         * @description 获取 Release 详情
         *
         *     Args:
         *         repo_id: 仓库ID
         *         release_number: Release 编号
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: Release 详情（包含附件）
         */
        get: operations["get_release_api_v1_repositories__repo_id__releases__release_number__get"];
        put?: never;
        post?: never;
        /**
         * Delete Release
         * @description 删除 Release
         *
         *     Args:
         *         repo_id: 仓库ID
         *         release_number: Release 编号
         *         db: 数据库会话
         *         current_user: 当前认证用户
         */
        delete: operations["delete_release_api_v1_repositories__repo_id__releases__release_number__delete"];
        options?: never;
        head?: never;
        /**
         * Update Release
         * @description 更新 Release
         *
         *     Args:
         *         repo_id: 仓库ID
         *         release_number: Release 编号
         *         data: 更新数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 更新后的 Release 数据
         */
        patch: operations["update_release_api_v1_repositories__repo_id__releases__release_number__patch"];
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/releases/tag/{tag_name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Release By Tag
         * @description 根据标签名称获取 Release
         *
         *     Args:
         *         repo_id: 仓库ID
         *         tag_name: 标签名称
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: Release 详情
         */
        get: operations["get_release_by_tag_api_v1_repositories__repo_id__releases_tag__tag_name__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/releases/{release_number}/assets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add Release Asset
         * @description 添加 Release 附件
         *
         *     Args:
         *         repo_id: 仓库ID
         *         release_number: Release 编号
         *         data: 附件数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 创建的附件数据
         */
        post: operations["add_release_asset_api_v1_repositories__repo_id__releases__release_number__assets_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/releases/{release_number}/assets/upload": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Upload Release Asset
         * @description 上传 Release 附件（multipart，二进制落盘 + 元数据注册）
         *
         *     Args:
         *         repo_id: 仓库ID
         *         release_number: Release 编号
         *         file: 上传的文件
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 创建的附件元数据
         */
        post: operations["upload_release_asset_api_v1_repositories__repo_id__releases__release_number__assets_upload_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/releases/{release_number}/assets/{asset_id}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Download Release Asset
         * @description 下载 Release 附件（流式返回文件，自增下载计数）
         *
         *     Args:
         *         repo_id: 仓库ID
         *         release_number: Release 编号
         *         asset_id: 附件ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         */
        get: operations["download_release_asset_api_v1_repositories__repo_id__releases__release_number__assets__asset_id__download_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/releases/{release_number}/assets/{asset_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete Release Asset
         * @description 删除 Release 附件
         *
         *     Args:
         *         repo_id: 仓库ID
         *         release_number: Release 编号
         *         asset_id: 附件ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         */
        delete: operations["delete_release_asset_api_v1_repositories__repo_id__releases__release_number__assets__asset_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/issues": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Issues
         * @description 获取 Issue 列表
         *
         *     Args:
         *         repo_id: 仓库ID
         *         status: 状态筛选
         *         label: 标签名称筛选
         *         assignee: 指派人ID筛选
         *         author: 作者ID筛选
         *         page: 页码
         *         limit: 每页数量
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: Issue 列表和分页信息
         */
        get: operations["list_issues_api_v1_repositories__repo_id__issues_get"];
        put?: never;
        /** Create Issue */
        post: operations["create_issue_api_v1_repositories__repo_id__issues_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/issues/filter": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Filter Issues
         * @description 高级筛选 Issue
         *
         *     Args:
         *         repo_id: 仓库ID
         *         data: 筛选条件
         *         sort_by: 排序字段
         *         sort_order: 排序方向
         *         page: 页码
         *         per_page: 每页数量
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 筛选结果
         */
        post: operations["filter_issues_api_v1_repositories__repo_id__issues_filter_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/issues/batch/close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Batch Close Issues
         * @description 批量关闭 Issue
         *
         *     Args:
         *         repo_id: 仓库ID
         *         data: Issue 编号列表
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 操作结果统计
         */
        post: operations["batch_close_issues_api_v1_repositories__repo_id__issues_batch_close_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/issues/batch/reopen": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Batch Reopen Issues
         * @description 批量重新打开 Issue
         *
         *     Args:
         *         repo_id: 仓库ID
         *         data: Issue 编号列表
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 操作结果统计
         */
        post: operations["batch_reopen_issues_api_v1_repositories__repo_id__issues_batch_reopen_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/issues/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Batch Update Issues
         * @description 批量更新 Issue
         *
         *     Args:
         *         repo_id: 仓库ID
         *         data: 更新数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 操作结果统计
         */
        patch: operations["batch_update_issues_api_v1_repositories__repo_id__issues_batch_patch"];
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/issues/batch/labels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Batch Add Labels
         * @description 批量为 Issue 添加标签
         *
         *     Args:
         *         repo_id: 仓库ID
         *         data: Issue 编号和标签ID列表
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 操作结果统计
         */
        post: operations["batch_add_labels_api_v1_repositories__repo_id__issues_batch_labels_post"];
        /**
         * Batch Remove Labels
         * @description 批量从 Issue 移除标签
         *
         *     Args:
         *         repo_id: 仓库ID
         *         data: Issue 编号和标签ID列表
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 操作结果统计
         */
        delete: operations["batch_remove_labels_api_v1_repositories__repo_id__issues_batch_labels_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/issues/{issue_number}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Issue
         * @description 获取 Issue 详情
         *
         *     Args:
         *         repo_id: 仓库ID
         *         issue_number: Issue 编号
         *         db: 数据库会话
         *
         *     Returns:
         *         dict: Issue 详情（包含评论）
         */
        get: operations["get_issue_api_v1_repositories__repo_id__issues__issue_number__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update Issue
         * @description 更新 Issue
         *
         *     Args:
         *         repo_id: 仓库ID
         *         issue_number: Issue 编号
         *         data: 更新数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 更新后的 Issue 数据
         */
        patch: operations["update_issue_api_v1_repositories__repo_id__issues__issue_number__patch"];
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/issues/{issue_number}/close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Close Issue
         * @description 关闭 Issue
         *
         *     Args:
         *         repo_id: 仓库ID
         *         issue_number: Issue 编号
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 更新后的 Issue 数据
         */
        post: operations["close_issue_api_v1_repositories__repo_id__issues__issue_number__close_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/issues/{issue_number}/reopen": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reopen Issue
         * @description 重新打开 Issue
         *
         *     Args:
         *         repo_id: 仓库ID
         *         issue_number: Issue 编号
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 更新后的 Issue 数据
         */
        post: operations["reopen_issue_api_v1_repositories__repo_id__issues__issue_number__reopen_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/issues/{issue_number}/comments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Issue Comments
         * @description 获取 Issue 评论列表
         *
         *     Args:
         *         repo_id: 仓库ID
         *         issue_number: Issue 编号
         *         db: 数据库会话
         *
         *     Returns:
         *         list: 评论列表
         */
        get: operations["list_issue_comments_api_v1_repositories__repo_id__issues__issue_number__comments_get"];
        put?: never;
        /**
         * Create Issue Comment
         * @description 创建 Issue 评论
         *
         *     Args:
         *         repo_id: 仓库ID
         *         issue_number: Issue 编号
         *         data: 评论数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 创建的评论数据
         */
        post: operations["create_issue_comment_api_v1_repositories__repo_id__issues__issue_number__comments_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/issues/{issue_number}/pull-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Issue Linked Prs
         * @description 列出关联该 Issue 的 PR。
         */
        get: operations["list_issue_linked_prs_api_v1_repositories__repo_id__issues__issue_number__pull_requests_get"];
        put?: never;
        /**
         * Link Issue Pr
         * @description 从 Issue 侧关联一个 PR（幂等）。
         */
        post: operations["link_issue_pr_api_v1_repositories__repo_id__issues__issue_number__pull_requests_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/issues/{issue_number}/pull-requests/{pr_number}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Unlink Issue Pr
         * @description 解除 Issue 与 PR 的关联。
         */
        delete: operations["unlink_issue_pr_api_v1_repositories__repo_id__issues__issue_number__pull_requests__pr_number__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 列出 SSH Keys
         * @description 获取当前用户的所有 SSH Key
         */
        get: operations["list_ssh_keys_api_v1_keys_get"];
        put?: never;
        /**
         * 添加 SSH Key
         * @description 为当前用户添加一个新的 SSH 公钥
         */
        post: operations["add_ssh_key_api_v1_keys_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/keys/{key_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * 删除 SSH Key
         * @description 删除指定的 SSH Key
         */
        delete: operations["delete_ssh_key_api_v1_keys__key_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/webhooks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Webhooks
         * @description 获取 WebHook 列表
         *
         *     Args:
         *         repo_id: 仓库ID
         *         page: 页码
         *         limit: 每页数量
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: WebHook 列表和分页信息
         */
        get: operations["list_webhooks_api_v1_repositories__repo_id__webhooks_get"];
        put?: never;
        /**
         * Create Webhook
         * @description 创建 WebHook
         *
         *     Args:
         *         repo_id: 仓库ID
         *         data: WebHook 数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 创建的 WebHook 数据
         */
        post: operations["create_webhook_api_v1_repositories__repo_id__webhooks_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/webhooks/{webhook_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Webhook
         * @description 获取 WebHook 详情
         *
         *     Args:
         *         repo_id: 仓库ID
         *         webhook_id: WebHook ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: WebHook 详情
         */
        get: operations["get_webhook_api_v1_repositories__repo_id__webhooks__webhook_id__get"];
        put?: never;
        post?: never;
        /**
         * Delete Webhook
         * @description 删除 WebHook
         *
         *     Args:
         *         repo_id: 仓库ID
         *         webhook_id: WebHook ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         */
        delete: operations["delete_webhook_api_v1_repositories__repo_id__webhooks__webhook_id__delete"];
        options?: never;
        head?: never;
        /**
         * Update Webhook
         * @description 更新 WebHook
         *
         *     Args:
         *         repo_id: 仓库ID
         *         webhook_id: WebHook ID
         *         data: 更新数据
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 更新后的 WebHook 数据
         */
        patch: operations["update_webhook_api_v1_repositories__repo_id__webhooks__webhook_id__patch"];
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/webhooks/{webhook_id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Test Webhook
         * @description 测试 WebHook
         *
         *     发送测试事件到 WebHook URL
         *
         *     Args:
         *         repo_id: 仓库ID
         *         webhook_id: WebHook ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 测试结果
         */
        post: operations["test_webhook_api_v1_repositories__repo_id__webhooks__webhook_id__test_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/webhooks/{webhook_id}/deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Webhook Deliveries
         * @description 获取 WebHook 投递记录列表
         *
         *     Args:
         *         repo_id: 仓库ID
         *         webhook_id: WebHook ID
         *         page: 页码
         *         limit: 每页数量
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 投递记录列表和分页信息
         */
        get: operations["list_webhook_deliveries_api_v1_repositories__repo_id__webhooks__webhook_id__deliveries_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/webhooks/{webhook_id}/deliveries/{delivery_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Webhook Delivery
         * @description 获取 WebHook 投递记录详情
         *
         *     Args:
         *         repo_id: 仓库ID
         *         webhook_id: WebHook ID
         *         delivery_id: 投递记录ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 投递记录详情
         */
        get: operations["get_webhook_delivery_api_v1_repositories__repo_id__webhooks__webhook_id__deliveries__delivery_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 获取仓库统计
         * @description 获取仓库聚合统计
         */
        get: operations["get_repo_stats_api_v1_repositories__repo_id__stats_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/activities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 获取仓库审计日志
         * @description 获取仓库审计日志，支持按实体类型和操作者过滤
         *
         *     决策：**公开仓匿名可读**维持不变——公开仓内容本就匿名可读，
         *     活动流属同级信息；私仓由 router 级 ``require_repo_read`` 挡住
         *     （匿名 401 / 非成员 403）。本端点刻意不挂 ``get_current_user``。
         */
        get: operations["list_activities_api_v1_repositories__repo_id__activities_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Notifications */
        get: operations["get_notifications_api_v1_notifications_get"];
        put?: never;
        /** Create Notification */
        post: operations["create_notification_api_v1_notifications_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/unread-count": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Unread Count */
        get: operations["get_unread_count_api_v1_notifications_unread_count_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/{notification_id}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Mark As Read */
        patch: operations["mark_as_read_api_v1_notifications__notification_id__read_patch"];
        trace?: never;
    };
    "/api/v1/notifications/read-all": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Mark All As Read */
        post: operations["mark_all_as_read_api_v1_notifications_read_all_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/preferences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Preferences */
        get: operations["get_preferences_api_v1_notifications_preferences_get"];
        /** Update Preferences */
        put: operations["update_preferences_api_v1_notifications_preferences_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/{notification_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Notification */
        delete: operations["delete_notification_api_v1_notifications__notification_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/room": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Repository Room */
        get: operations["get_repository_room_api_v1_repositories__repo_id__room_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Rooms
         * @description 列出当前用户已加入的所有活跃房间
         *
         *     Args:
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         list[dict]: 房间列表（id/repository_id/name/topic/is_active/created_at）
         */
        get: operations["list_rooms_api_v1_rooms_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{room_id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Room Members */
        get: operations["get_room_members_api_v1_rooms__room_id__members_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{room_id}/members/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set Room Member Muted
         * @description 本人静音/取消静音某会话（频道或私聊）。静音后该会话不再累计未读。
         */
        post: operations["set_room_member_muted_api_v1_rooms__room_id__members_me_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{room_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Room */
        delete: operations["delete_room_api_v1_rooms__room_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{room_id}/attachments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Upload Room Attachment
         * @description 上传聊天附件
         *
         *     仅房间成员可上传；返回的 url 可直接作为 Markdown 链接/图片插入消息内容
         */
        post: operations["upload_room_attachment_api_v1_rooms__room_id__attachments_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attachments/{room_id}/{stored_name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Download Room Attachment
         * @description 下载聊天附件（需认证，文件名含随机 token 防遍历/猜测）
         */
        get: operations["download_room_attachment_api_v1_attachments__room_id___stored_name__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/dm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Dms
         * @description 列出当前用户的私聊会话（含对方信息与未读数）
         */
        get: operations["list_dms_api_v1_dm_get"];
        put?: never;
        /**
         * Get Or Create Dm
         * @description 获取或创建当前用户与 peer_user_id 的私聊会话（幂等）
         */
        post: operations["get_or_create_dm_api_v1_dm_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/unread": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Unread Counts */
        get: operations["get_unread_counts_api_v1_rooms_unread_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{room_id}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Mark Room Read */
        post: operations["mark_room_read_api_v1_rooms__room_id__read_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{room_id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Room Messages */
        get: operations["get_room_messages_api_v1_rooms__room_id__messages_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/messages/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search Messages
         * @description 跨当前用户加入的全部会话检索消息（聊天侧边栏搜索框）
         */
        get: operations["search_messages_api_v1_messages_search_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{room_id}/messages/{msg_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Message */
        delete: operations["delete_message_api_v1_rooms__room_id__messages__msg_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{room_id}/messages/{msg_id}/reactions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Add Message Reaction */
        post: operations["add_message_reaction_api_v1_rooms__room_id__messages__msg_id__reactions_post"];
        /** Remove Message Reaction */
        delete: operations["remove_message_reaction_api_v1_rooms__room_id__messages__msg_id__reactions_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search Code
         * @description 搜索仓库代码
         *
         *     Args:
         *         repo_id: 仓库ID
         *         q: 搜索关键词
         *         path: 限制搜索目录
         *         ref: 分支/标签/提交（缺省默认分支）
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 搜索结果
         */
        get: operations["search_code_api_v1_repositories__repo_id__search_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/symbols/{name}/definition": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Find Symbol Definition
         * @description 按精确符号名查找定义（符号图）。
         *
         *     块级索引只覆盖默认分支 HEAD；传入非默认 ``ref`` 时改为按该 ref 现场扫描，
         *     响应中的 ``source`` / ``partial`` 用于标明答案来源与是否可能被护栏截断。
         */
        get: operations["find_symbol_definition_api_v1_repositories__repo_id__symbols__name__definition_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/symbols/{name}/usages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Find Symbol Usages
         * @description 按精确标识符名查找引用，附引用点所在符号块（引用图）。
         */
        get: operations["find_symbol_usages_api_v1_repositories__repo_id__symbols__name__usages_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/search/index-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search Index Status
         * @description 索引状态（认证 + 读权限即可；只读派生数据，不触发构建）
         *
         *     Returns:
         *         dict: ``{head_commit, indexed_commit, index_generation,
         *         current_generation, in_sync, chunks, refs, embeddings,
         *         semantic_enabled, last_indexed_at}``
         */
        get: operations["search_index_status_api_v1_repositories__repo_id__search_index_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/search/reindex": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Search Reindex
         * @description 手动重建块级索引（认证 + 读权限即可，**非管理员专属**）
         *
         *     后台执行（大仓可达数十秒，避免同步请求撞网关超时）；响应 ``{started}``，
         *     前端轮询 ``index-status`` 等待 ``in_sync`` 翻转。同进程重复触发由
         *     per-repo 重建锁挡下（``started=false, reason=rebuilding``）；
         *     跨进程重复触发无害（Redis NX 锁使后到者空转返回）。
         *
         *     Returns:
         *         dict: ``{started: bool, reason?: "rebuilding"}``
         */
        post: operations["search_reindex_api_v1_repositories__repo_id__search_reindex_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/search/code": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Global Search Code
         * @description 跨仓库代码搜索
         *
         *     在用户有权限访问的所有仓库中搜索代码，结果按仓库聚合。
         *
         *     Args:
         *         q: 搜索关键词
         *         path: 限制搜索目录
         *         ref: 分支/标签/提交（缺省各仓库默认分支）
         *         max_results: 最大返回结果总数
         *         per_repo_max: 单个仓库最大结果数
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 搜索结果（按仓库聚合）
         */
        get: operations["global_search_code_api_v1_search_code_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/search/global": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Global Search
         * @description 全局聚合搜索（仓库/Issue/PR）
         *
         *     在用户可访问的仓库范围内，按关键词搜索：
         *     - 仓库名称 / 路径 / 描述
         *     - Issue 标题 / 描述
         *     - PR 标题 / 描述
         *
         *     三类结果分组合并返回，每类最多 per_type 条。
         *
         *     Args:
         *         q: 搜索关键词
         *         per_type: 每类结果最大返回数
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 三类分组搜索结果
         */
        get: operations["global_search_api_v1_search_global_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/agent/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Agent Jobs */
        get: operations["list_agent_jobs_api_v1_repositories__repo_id__agent_jobs_get"];
        put?: never;
        /** Create Agent Job */
        post: operations["create_agent_job_api_v1_repositories__repo_id__agent_jobs_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/agent/jobs/{job_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Agent Job */
        get: operations["get_agent_job_api_v1_repositories__repo_id__agent_jobs__job_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/agent/jobs/{job_id}/steps": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Agent Job Steps */
        get: operations["get_agent_job_steps_api_v1_repositories__repo_id__agent_jobs__job_id__steps_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/agent/jobs/{job_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel Agent Job */
        post: operations["cancel_agent_job_api_v1_repositories__repo_id__agent_jobs__job_id__cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/agent/jobs/{job_id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve Agent Tool Call
         * @description 批准作业挂起的写工具调用，作业重新入队继续执行。
         */
        post: operations["approve_agent_tool_call_api_v1_repositories__repo_id__agent_jobs__job_id__approve_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/agent/jobs/{job_id}/reject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reject Agent Tool Call
         * @description 拒绝作业挂起的写工具调用；该工具不执行，原因回灌给模型。
         */
        post: operations["reject_agent_tool_call_api_v1_repositories__repo_id__agent_jobs__job_id__reject_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/builds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Builds */
        get: operations["list_builds_api_v1_repositories__repo_id__builds_get"];
        put?: never;
        /** Create Build */
        post: operations["create_build_api_v1_repositories__repo_id__builds_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/builds/{build_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Build */
        get: operations["get_build_api_v1_repositories__repo_id__builds__build_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update Build
         * @description 更新构建状态。
         *
         *     外部 CI runner 无需用户 token: 通过 X-Kustos-Signature 头携带
         *     HMAC-SHA256 签名 (https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries)
         *     回调; 否则回落到用户 token 鉴权。
         */
        patch: operations["update_build_api_v1_repositories__repo_id__builds__build_id__patch"];
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/builds/{build_id}/logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Build Logs
         * @description 获取构建日志
         *
         *     - 兼容: 不带 after_seq 时返回整串 `logs`（旧行为），并附增量契约字段；
         *     - 增量: 带 `after_seq` 时按 build_log_entries 子表只回 `seq>after_seq` 的
         *       entries（逐条 seq/stream/line/logged_at），next_seq 为增量光标。
         *
         *     Args:
         *         repo_id: 仓库ID
         *         build_id: 构建ID
         *         after_seq: 增量边界（只回大于该 seq 的条目，默认 0=全部）
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: {"logs": 整串兼容, "entries": [逐条], "next_seq": 增量光标}
         */
        get: operations["get_build_logs_api_v1_repositories__repo_id__builds__build_id__logs_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 获取所有仓库
         * @description 获取所有仓库（需要认证）
         *
         *     Args:
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         list[Repository]: 仓库列表
         */
        get: operations["get_repositories_api_v1_repositories_get"];
        put?: never;
        /**
         * 创建新仓库
         * @description 创建新仓库（需要认证）
         *
         *     路径自动生成，格式为: {username}/{repo_name}
         *     符合 Git HTTP 标准 URL 格式
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         repo: 仓库信息（包含 name, description, is_public, default_branch 等）
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         Repository: 创建的仓库信息
         *
         *     Raises:
         *         ValidationException: 请求参数不完整时抛出422异常
         *         ConflictException: 仓库路径已存在时抛出409异常
         */
        post: operations["create_repository_api_v1_repositories_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/public": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Public Repositories
         * @description 获取所有公开仓库
         *
         *     Args:
         *         db: 数据库会话
         *
         *     Returns:
         *         list[Repository]: 公开仓库列表
         */
        get: operations["get_public_repositories_api_v1_repositories_public_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/user/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repositories By User
         * @description 根据用户ID获取仓库列表（需要认证）
         *
         *     Args:
         *         user_id: 用户ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         list[Repository]: 用户的仓库列表
         */
        get: operations["get_repositories_by_user_api_v1_repositories_user__user_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository
         * @description 根据ID获取仓库（需要认证）
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 异步数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         Repository: 仓库信息
         *
         *     Raises:
         *         NotFoundException: 仓库不存在时抛出404异常
         */
        get: operations["get_repository_api_v1_repositories__repo_id__get"];
        /**
         * Update Repository
         * @description 更新仓库信息（需要认证）
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         repo_id: 仓库ID
         *         repo: 更新的仓库信息
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         Repository: 更新后的仓库信息
         *
         *     Raises:
         *         NotFoundException: 仓库不存在时抛出404异常
         *         AuthorizationException: 无权限时抛出403异常
         */
        put: operations["update_repository_api_v1_repositories__repo_id__put"];
        post?: never;
        /**
         * Delete Repository
         * @description 删除仓库（需要认证）
         *
         *     Args:
         *         request: HTTP请求对象（用于速率限制）
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 删除成功消息
         *
         *     Raises:
         *         NotFoundException: 仓库不存在时抛出404异常
         *         AuthorizationException: 无权限时抛出403异常
         */
        delete: operations["delete_repository_api_v1_repositories__repo_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/access": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Check Repository Access
         * @description 检查用户对仓库的访问权限（需要认证）
         *
         *     Args:
         *         repo_id: 仓库ID
         *         user_id: 用户ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         dict: 访问权限信息
         *
         *     Raises:
         *         NotFoundException: 仓库不存在时抛出404异常
         */
        get: operations["check_repository_access_api_v1_repositories__repo_id__access_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/archive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 归档仓库
         * @description 归档仓库（需要认证）
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         Repository: 归档后的仓库信息
         *
         *     Raises:
         *         NotFoundException: 仓库不存在时抛出404异常
         *         AuthorizationException: 无权限时抛出403异常
         */
        post: operations["archive_repository_api_v1_repositories__repo_id__archive_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repositories/{repo_id}/unarchive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 取消归档仓库
         * @description 取消归档仓库（需要认证）
         *
         *     Args:
         *         repo_id: 仓库ID
         *         db: 数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         Repository: 取消归档后的仓库信息
         *
         *     Raises:
         *         NotFoundException: 仓库不存在时抛出404异常
         *         AuthorizationException: 无权限时抛出403异常
         */
        post: operations["unarchive_repository_api_v1_repositories__repo_id__unarchive_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repo/{owner}/{repo}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Repository By Path
         * @description 根据 owner/repo 路径获取仓库（需要认证）
         *
         *     Args:
         *         owner: 仓库所有者用户名
         *         repo: 仓库名称
         *         db: 异步数据库会话
         *         current_user: 当前认证用户
         *
         *     Returns:
         *         Repository: 仓库信息
         *
         *     Raises:
         *         NotFoundException: 仓库不存在时抛出404异常
         *         AuthorizationException: 无权限访问私有仓库时抛出403异常
         */
        get: operations["get_repository_by_path_api_v1_repo__owner___repo__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/debug/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Debug Status
         * @description 获取调试状态信息
         *
         *     显示当前调试模式状态、配置文件状态、环境变量等信息
         *
         *     Returns:
         *         DebugStatusResponse: 调试状态信息
         */
        get: operations["debug_status_api_v1_debug_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/debug/initdb": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Init Database
         * @description 重置数据库
         *
         *     删除所有表并重新建立，启动时自动引导管理员用户。
         *
         *     Args:
         *         force: 是否强制重置（跳过确认提示，始终为 true）
         *
         *     Returns:
         *         InitDbResponse: 操作结果
         *
         *     Raises:
         *         HTTPException: 非调试模式或权限不足时
         */
        post: operations["init_database_api_v1_debug_initdb_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/debug/initconf": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Init Config
         * @description 重置配置（恢复模板默认值）
         *
         *     把 ``config.example.toml`` 过滤后的种子值**覆盖**写入 ``app_config``，
         *     随后各进程经配置版本检测收敛。TOML 层移除后不再产生/备份配置文件
         *     （``backup``/``force`` 仅为兼容保留，无副作用）。
         *
         *     Returns:
         *         InitConfResponse: 操作结果（``config_path`` 为 null——不再写文件）
         *
         *     Raises:
         *         HTTPException: 非调试模式或权限不足
         *         AppServiceException: 模板缺失或重置失败
         */
        post: operations["init_config_api_v1_debug_initconf_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/errors/info/{error_code}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Error Info
         * @description 获取错误详细信息
         *
         *     根据配置和用户权限返回不同详细程度的错误信息
         *     - 调试模式：返回完整错误详情和堆栈跟踪
         *     - 管理员：返回完整错误详情和堆栈跟踪
         *     - 普通用户：仅返回状态码和基础错误信息
         *
         *     Args:
         *         error_code: HTTP 错误状态码
         *         message: 错误消息
         *         error_type: 错误类型
         *         details: 错误详情
         *         request_id: 请求ID
         *         current_user: 当前用户信息（可选）
         *
         *     Returns:
         *         ErrorInfoResponse: 错误信息响应
         */
        get: operations["get_error_info_api_v1_errors_info__error_code__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/errors/recent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Recent Errors
         * @description 获取最近的错误日志（仅管理员可用）
         *
         *     Args:
         *         limit: 返回条目数量限制
         *         current_user: 当前管理员用户
         *
         *     Returns:
         *         list[ErrorLogEntry]: 错误日志列表
         */
        get: operations["get_recent_errors_api_v1_errors_recent_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/errors/report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Report Error
         * @description 接收前端报告的错误
         *
         *     用于前端捕获到未处理的错误时上报给服务端
         *
         *     Args:
         *         error_data: 错误数据
         *         request: 请求对象
         *         current_user: 当前用户信息（可选）
         *
         *     Returns:
         *         dict: 处理结果
         */
        post: operations["report_error_api_v1_errors_report_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * ActionResponse
         * @description 操作响应模型
         */
        ActionResponse: {
            /** Success */
            success: boolean;
            /** Message */
            message: string;
        };
        /**
         * AddAssetRequest
         * @description 添加 Release 附件请求体
         */
        AddAssetRequest: {
            /**
             * Name
             * @description 文件名
             */
            name: string;
            /**
             * File Path
             * @description 文件存储路径
             */
            file_path: string;
            /**
             * File Size
             * @description 文件大小（字节）
             */
            file_size: number;
            /**
             * Content Type
             * @description MIME 类型
             */
            content_type?: string | null;
        };
        /**
         * AddSSHKeyRequest
         * @description 添加 SSH Key 请求体
         */
        AddSSHKeyRequest: {
            /**
             * Name
             * @description Key 名称
             */
            name: string;
            /**
             * Public Key
             * @description SSH 公钥内容
             */
            public_key: string;
        };
        /**
         * AdminResetPasswordRequest
         * @description 管理员重置用户密码请求体
         */
        AdminResetPasswordRequest: {
            /**
             * New Password
             * @description 新密码
             */
            new_password: string;
        };
        /**
         * AgentConfigPutRequest
         * @description 配置保存请求（``{values, version}`` + 密钥字段）
         */
        AgentConfigPutRequest: {
            /**
             * Values
             * @description 可写白名单键的部分更新（白名单见 GET meta.editable_keys）
             */
            values: {
                [key: string]: unknown;
            };
            /**
             * Version
             * @description 乐观锁版本（GET meta.version，不符 → 409）
             */
            version: number;
            /**
             * Api Key
             * @description LLM API key 明文（仅本次请求在内存使用，密文落库；缺省不修改）
             */
            api_key?: string | null;
            /**
             * Clear Api Key
             * @description 清除 DB 中保存的 API key（与 api_key 互斥）
             * @default false
             */
            clear_api_key: boolean;
        };
        /** ApprovalRequest */
        ApprovalRequest: {
            /**
             * Reason
             * @description 批准/拒绝的附言（拒绝时回灌给模型）
             */
            reason?: string | null;
        };
        /**
         * AuditListResponse
         * @description 审计统一查询响应模型
         */
        AuditListResponse: {
            /** Items */
            items: unknown[];
            /** Total */
            total: number;
            /** Page */
            page: number;
            /** Limit */
            limit: number;
            /** Pages */
            pages: number;
            /** Has Next */
            has_next: boolean;
            /** Has Prev */
            has_prev: boolean;
            /**
             * Truncated
             * @description 是否已达日志扫描行数上限、更早的记录可能未纳入统计
             * @default false
             */
            truncated: boolean;
        };
        /**
         * BatchIssueNumbersRequest
         * @description 批量操作请求体
         */
        BatchIssueNumbersRequest: {
            /**
             * Issue Numbers
             * @description Issue 编号列表
             */
            issue_numbers: number[];
        };
        /**
         * BatchLabelsRequest
         * @description 批量标签操作请求体
         */
        BatchLabelsRequest: {
            /**
             * Issue Numbers
             * @description Issue 编号列表
             */
            issue_numbers: number[];
            /**
             * Label Ids
             * @description 标签ID列表
             */
            label_ids: string[];
        };
        /**
         * BatchUpdateRequest
         * @description 批量更新请求体
         */
        BatchUpdateRequest: {
            /**
             * Issue Numbers
             * @description Issue 编号列表
             */
            issue_numbers: number[];
            /**
             * Updates
             * @description 更新字段
             */
            updates: {
                [key: string]: unknown;
            };
        };
        /** Body_upload_current_user_avatar_api_v1_users_me_avatar_post */
        Body_upload_current_user_avatar_api_v1_users_me_avatar_post: {
            /**
             * File
             * @description 头像图片文件（JPEG/PNG/GIF/WebP，最大5MB）
             */
            file: string;
        };
        /** Body_upload_release_asset_api_v1_repositories__repo_id__releases__release_number__assets_upload_post */
        Body_upload_release_asset_api_v1_repositories__repo_id__releases__release_number__assets_upload_post: {
            /**
             * File
             * @description 附件文件（最大 50MB）
             */
            file: string;
        };
        /** Body_upload_room_attachment_api_v1_rooms__room_id__attachments_post */
        Body_upload_room_attachment_api_v1_rooms__room_id__attachments_post: {
            /**
             * File
             * @description 附件文件（最大 20MB）
             */
            file: string;
        };
        /**
         * ChangePasswordRequest
         * @description 修改密码请求体
         */
        ChangePasswordRequest: {
            /**
             * Old Password
             * @description 旧密码
             */
            old_password: string;
            /**
             * New Password
             * @description 新密码
             */
            new_password: string;
        };
        /** CollabAuthRequest */
        CollabAuthRequest: {
            /** Token */
            token: string;
            /** Dockey */
            docKey: string;
            /** Invite Token */
            invite_token?: string | null;
        };
        /** CollabSaveRequest */
        CollabSaveRequest: {
            /** Token */
            token: string;
            /** Dockey */
            docKey: string;
            /** Content */
            content: string;
            /** Message */
            message?: string | null;
            /** Invite Token */
            invite_token?: string | null;
            /**
             * Draft
             * @default false
             */
            draft: boolean;
        };
        /**
         * ComponentInfo
         * @description 编排组件（容器）状态
         */
        ComponentInfo: {
            /** Service */
            service: string;
            /** Name */
            name: string;
            /** Label */
            label?: string | null;
            /** State */
            state: string;
            /** Health */
            health?: string | null;
            /** Running */
            running: boolean;
            /** Image */
            image?: string | null;
            /** Started At */
            started_at?: string | null;
            /** Uptime Seconds */
            uptime_seconds?: number | null;
            /** Restart Count */
            restart_count?: number | null;
            /** Exit Code */
            exit_code?: number | null;
            /** Status Text */
            status_text?: string | null;
        };
        /**
         * ComponentsResponse
         * @description 编排组件状态响应模型
         */
        ComponentsResponse: {
            /** Available */
            available: boolean;
            /**
             * Runtime
             * @default docker
             */
            runtime: string;
            /** Project */
            project?: string | null;
            /** Reason */
            reason?: string | null;
            /** Generated At */
            generated_at: string;
            /** Components */
            components?: components["schemas"]["ComponentInfo"][];
            /** Summary */
            summary?: {
                [key: string]: number;
            };
        };
        /**
         * ConfigResponse
         * @description 配置响应模型
         */
        ConfigResponse: {
            /** Success */
            success: boolean;
            /** Data */
            data?: {
                [key: string]: unknown;
            } | null;
            /** Errors */
            errors?: unknown[];
            /**
             * Hints
             * @description 提示信息列表，如需要重启的提示
             */
            hints?: unknown[];
            /**
             * Meta
             * @description 增强信息：sources={节:{键: env|db|default}}，供前端标注取值来源
             */
            meta?: {
                [key: string]: unknown;
            } | null;
        };
        /**
         * ConfigUpdateRequest
         * @description 配置更新请求模型
         */
        ConfigUpdateRequest: {
            /**
             * Config
             * @description 新的配置数据
             */
            config: {
                [key: string]: unknown;
            };
        };
        /** CreateBuildRequest */
        CreateBuildRequest: {
            /** Branch */
            branch: string;
            /** Commit Sha */
            commit_sha: string;
            /** Commit Message */
            commit_message?: string | null;
        };
        /** CreateJobRequest */
        CreateJobRequest: {
            /**
             * Prompt
             * @description 用户问题/任务（长度上限读 agent.max_prompt_chars）
             */
            prompt: string;
            /**
             * Session Id
             * @description 复用已有会话
             */
            session_id?: string | null;
            /**
             * Api Key
             * @description LLM API key（仅内存使用，不落库）
             */
            api_key?: string | null;
            /**
             * Base Url
             * @description OpenAI 兼容 base_url（可选覆盖；须在服务端白名单内）
             */
            base_url?: string | null;
            /**
             * Model
             * @description 模型名（可选覆盖）
             */
            model?: string | null;
        };
        /** CreateNotificationRequest */
        CreateNotificationRequest: {
            /**
             * Type
             * @description 通知类型: pull_request, issue, review, comment
             */
            type: string;
            /**
             * Title
             * @description 通知标题
             */
            title: string;
            /**
             * Message
             * @description 通知内容
             */
            message: string;
            /**
             * Repository Id
             * @description 关联仓库 ID
             */
            repository_id?: string | null;
            /**
             * Target Type
             * @description 目标类型
             */
            target_type?: string | null;
            /**
             * Target Id
             * @description 目标 ID
             */
            target_id?: string | null;
        };
        /**
         * CreateReleaseRequest
         * @description 创建 Release 请求体
         */
        CreateReleaseRequest: {
            /**
             * Tag Name
             * @description Git 标签名称
             */
            tag_name: string;
            /**
             * Name
             * @description Release 标题
             */
            name: string;
            /**
             * Description
             * @description Release 描述（Markdown）
             */
            description?: string | null;
            /**
             * Commit Hash
             * @description 关联的提交哈希
             */
            commit_hash?: string | null;
            /**
             * Is Draft
             * @description 是否为草稿
             * @default false
             */
            is_draft: boolean;
            /**
             * Is Prerelease
             * @description 是否为预发布版本
             * @default false
             */
            is_prerelease: boolean;
            /**
             * Create Git Tag
             * @description 是否同时创建 Git 标签
             * @default true
             */
            create_git_tag: boolean;
        };
        /**
         * CreateWebhookRequest
         * @description 创建 WebHook 请求体
         */
        CreateWebhookRequest: {
            /**
             * Url
             * @description 回调 URL
             */
            url: string;
            /**
             * Events
             * @description 订阅的事件列表
             */
            events: string[];
            /**
             * Secret
             * @description 签名密钥
             */
            secret?: string | null;
            /**
             * Content Type
             * @description Content-Type
             * @default application/json
             */
            content_type: string;
            /**
             * Is Active
             * @description 是否激活
             * @default true
             */
            is_active: boolean;
        };
        /**
         * DMCreateRequest
         * @description 创建/获取私聊会话请求体
         */
        DMCreateRequest: {
            /**
             * Peer User Id
             * Format: uuid
             * @description 私聊对象用户ID
             */
            peer_user_id: string;
        };
        /**
         * DebugStatusResponse
         * @description 调试状态响应模型
         */
        DebugStatusResponse: {
            /** Debug Mode */
            debug_mode: boolean;
            /** Config Path */
            config_path: string;
            /** Config Exists */
            config_exists: boolean;
            /**
             * Config Source
             * @description 配置源链健康态：db / degraded
             */
            config_source: string;
            /** Database Url */
            database_url: string;
            /** Database Type */
            database_type: string;
            /**
             * Environment
             * @description 环境变量信息
             */
            environment?: {
                [key: string]: unknown;
            };
            /**
             * Stress Test Mode
             * @description 是否处于压力测试模式
             * @default false
             */
            stress_test_mode: boolean;
        };
        /**
         * DebugToggleRequest
         * @description 调试模式切换请求
         */
        DebugToggleRequest: {
            /**
             * Enabled
             * @description 是否开启调试模式
             */
            enabled: boolean;
        };
        /**
         * DebugToggleResponse
         * @description 调试模式切换响应
         */
        DebugToggleResponse: {
            /** Success */
            success: boolean;
            /** Debug */
            debug?: boolean | null;
            /**
             * Restart Required
             * @default true
             */
            restart_required: boolean;
            /** Message */
            message: string;
        };
        /**
         * ErrorInfoResponse
         * @description 错误信息响应模型
         */
        ErrorInfoResponse: {
            /** Code */
            code: number;
            /** Message */
            message: string;
            /** Type */
            type: string;
            /** Details */
            details?: string | null;
            /** Traceback */
            traceback?: string | null;
            /** Timestamp */
            timestamp: string;
            /** Path */
            path?: string | null;
            /** Request Id */
            request_id?: string | null;
        };
        /**
         * ErrorLogEntry
         * @description 错误日志条目
         */
        ErrorLogEntry: {
            /** Id */
            id: string;
            /** Timestamp */
            timestamp: string;
            /** Code */
            code: number;
            /** Type */
            type: string;
            /** Message */
            message: string;
            /** Path */
            path?: string | null;
            /** User Id */
            user_id?: string | null;
        };
        /**
         * FileCommentCreateRequest
         * @description 创建行内评论请求体
         */
        FileCommentCreateRequest: {
            /**
             * Content
             * @description 评论内容
             */
            content: string;
            /**
             * File Path
             * @description 文件路径
             */
            file_path: string;
            /**
             * Line Number
             * @description 行号
             */
            line_number?: number | null;
            /**
             * Branch
             * @description 分支名
             */
            branch?: string | null;
            /**
             * Commit Hash
             * @description 提交哈希
             */
            commit_hash?: string | null;
            /**
             * Parent Id
             * @description 父评论ID（回复）
             */
            parent_id?: string | null;
        };
        /**
         * FileCommentResolveRequest
         * @description 解决/重新打开评论请求体
         */
        FileCommentResolveRequest: {
            /**
             * Resolved
             * @description 是否已解决
             */
            resolved: boolean;
        };
        /**
         * FileCommitRequest
         * @description 文件提交请求体
         */
        FileCommitRequest: {
            /**
             * Content
             * @description 文件文本内容
             */
            content: string;
            /**
             * Message
             * @description 提交信息, 默认 Update <path>
             */
            message?: string | null;
            /**
             * Branch
             * @description 目标分支, 默认仓库默认分支
             */
            branch?: string | null;
        };
        /**
         * FileMoveRequest
         * @description 文件重命名/移动请求体
         */
        FileMoveRequest: {
            /**
             * From Path
             * @description 源文件路径
             */
            from_path: string;
            /**
             * To Path
             * @description 目标路径
             */
            to_path: string;
            /**
             * Message
             * @description 提交信息, 默认 Move <from> -> <to>
             */
            message?: string | null;
            /**
             * Branch
             * @description 目标分支, 默认仓库默认分支
             */
            branch?: string | null;
        };
        /**
         * ForkCreateRequest
         * @description 创建 Fork 请求体
         */
        ForkCreateRequest: {
            /**
             * Name
             * @description Fork 仓库名称（默认为源仓库名称）
             */
            name?: string | null;
            /**
             * Description
             * @description Fork 仓库描述
             */
            description?: string | null;
            /**
             * Is Public
             * @description 是否公开（默认为源仓库设置）
             */
            is_public?: boolean | null;
        };
        /**
         * GrafanaSsoResponse
         * @description Grafana SSO 登录响应（会话 Cookie 已随响应下发）
         */
        GrafanaSsoResponse: {
            /** Ok */
            ok: boolean;
            /** Entry */
            entry: string;
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /**
         * InitConfResponse
         * @description 重置配置响应模型
         */
        InitConfResponse: {
            /** Success */
            success: boolean;
            /** Message */
            message: string;
            /** Config Path */
            config_path?: string | null;
            /** Backup Path */
            backup_path?: string | null;
        };
        /**
         * InitDbResponse
         * @description 初始化数据库响应模型
         */
        InitDbResponse: {
            /** Success */
            success: boolean;
            /** Message */
            message: string;
            /** Details */
            details?: {
                [key: string]: unknown;
            };
        };
        /**
         * IssueCommentCreateRequest
         * @description 创建 Issue 评论请求体
         */
        IssueCommentCreateRequest: {
            /**
             * Content
             * @description 评论内容
             */
            content: string;
        };
        /**
         * IssueCreateRequest
         * @description 创建 Issue 请求体
         */
        IssueCreateRequest: {
            /**
             * Title
             * @description 标题
             */
            title: string;
            /**
             * Description
             * @description 描述
             */
            description?: string | null;
            /**
             * Priority
             * @description 优先级：low/medium/high/critical
             * @default medium
             */
            priority: string;
            /**
             * Assignee Id
             * @description 指派人ID
             */
            assignee_id?: string | null;
            /**
             * Label Ids
             * @description 标签ID列表
             */
            label_ids?: string[] | null;
        };
        /**
         * IssueFilterRequest
         * @description Issue 筛选请求体
         */
        IssueFilterRequest: {
            /**
             * Statuses
             * @description 状态列表
             */
            statuses?: string[] | null;
            /**
             * Priorities
             * @description 优先级列表
             */
            priorities?: string[] | null;
            /**
             * Assignee Ids
             * @description 指派人ID列表
             */
            assignee_ids?: string[] | null;
            /**
             * Author Ids
             * @description 作者ID列表
             */
            author_ids?: string[] | null;
            /**
             * Label Ids
             * @description 标签ID列表
             */
            label_ids?: string[] | null;
            /**
             * Search
             * @description 搜索关键词
             */
            search?: string | null;
        };
        /**
         * IssueInviteRequest
         * @description 邀请链接签发请求体
         */
        IssueInviteRequest: {
            /**
             * Doc Key
             * @description 文档标识 repository_id:branch:path
             */
            doc_key: string;
            /**
             * Scope
             * @description 权限档位
             * @default read
             */
            scope: string;
            /**
             * Ttl Minutes
             * @description 有效期(分钟)
             */
            ttl_minutes?: number | null;
        };
        /**
         * IssueLinkPRRequest
         * @description 关联 PR 请求体
         */
        IssueLinkPRRequest: {
            /**
             * Pr Number
             * @description 同仓库内的 PR 编号
             */
            pr_number: number;
            /**
             * Closes On Merge
             * @description 该 PR 合并时自动关闭此 Issue
             * @default true
             */
            closes_on_merge: boolean;
        };
        /**
         * IssueUpdateRequest
         * @description 更新 Issue 请求体
         */
        IssueUpdateRequest: {
            /**
             * Title
             * @description 标题
             */
            title?: string | null;
            /**
             * Description
             * @description 描述
             */
            description?: string | null;
            /**
             * Priority
             * @description 优先级：low/medium/high/critical
             */
            priority?: string | null;
            /**
             * Assignee Id
             * @description 指派人ID
             */
            assignee_id?: string | null;
            /**
             * Label Ids
             * @description 标签ID列表
             */
            label_ids?: string[] | null;
        };
        /**
         * KickRequest
         * @description 踢出会话成员请求体
         */
        KickRequest: {
            /**
             * Doc Key
             * @description 文档标识 repository_id:branch:path
             */
            doc_key: string;
            /**
             * User Id
             * Format: uuid
             * @description 被踢出的成员用户ID
             */
            user_id: string;
        };
        /**
         * LogCleanupResponse
         * @description 日志清理响应模型
         */
        LogCleanupResponse: {
            /** Success */
            success: boolean;
            /** Deleted Count */
            deleted_count: number;
            /** Keep Days */
            keep_days: number;
        };
        /**
         * LogContentResponse
         * @description 日志内容响应模型
         */
        LogContentResponse: {
            /** Date */
            date: string;
            /** Log Name */
            log_name: string;
            /** Lines */
            lines: number;
            /** Total Lines */
            total_lines: number;
            /** Content */
            content: string;
            /** Exists */
            exists: boolean;
            /**
             * Window Parts
             * @description 返回窗口覆盖的分片（旧→新）
             */
            window_parts?: unknown[];
            /**
             * Segment Starts
             * @description 各分片在窗口内的起始行偏移
             */
            segment_starts?: unknown[];
            /**
             * Truncated
             * @description 是否已达保留上限、更早分片可能被丢弃
             * @default false
             */
            truncated: boolean;
        };
        /** LogEntryIn */
        LogEntryIn: {
            /**
             * Stream
             * @default stdout
             * @enum {string}
             */
            stream: "stdout" | "stderr";
            /** Line */
            line: string;
        };
        /**
         * LogInfoResponse
         * @description 日志信息响应模型
         */
        LogInfoResponse: {
            /** Log Dir */
            log_dir: string;
            /** Today Dir */
            today_dir: string;
            /** Today Files */
            today_files: unknown[];
            /** Available Dates */
            available_dates: unknown[];
        };
        /**
         * LoginRequest
         * @description 登录请求体
         */
        LoginRequest: {
            /**
             * Username
             * @description 用户名
             */
            username: string;
            /**
             * Password
             * @description 密码
             */
            password: string;
        };
        /**
         * LogoutRequest
         * @description 登出请求体
         */
        LogoutRequest: {
            /**
             * Refresh Token
             * @description 可选的刷新令牌，一并撤销
             */
            refresh_token?: string | null;
        };
        /**
         * MetricsPoint
         * @description 概览时序单点（一个降采样桶）
         */
        MetricsPoint: {
            /**
             * T
             * @description 桶结束时刻（epoch 毫秒）
             */
            t: number;
            /**
             * Rpm
             * @description 每分钟请求数（桶内均值）
             * @default 0
             */
            rpm: number;
            /**
             * Err Rate
             * @description 错误率百分比（非 2xx/3xx 占比）
             * @default 0
             */
            err_rate: number;
            /**
             * Avg Ms
             * @description 平均响应时间（毫秒）
             * @default 0
             */
            avg_ms: number;
            /**
             * P95 Ms
             * @description P95 响应时间（毫秒，直方图估算）
             * @default 0
             */
            p95_ms: number;
            /**
             * Mem Mb
             * @description 进程内存 RSS（MB，跨 worker 求和）
             */
            mem_mb?: number | null;
            /**
             * Cpu Pct
             * @description 进程 CPU 占用（%，跨 worker 求和）
             */
            cpu_pct?: number | null;
            /**
             * S2Xx
             * @description 2xx 请求数
             * @default 0
             */
            s2xx: number;
            /**
             * S3Xx
             * @description 3xx 请求数
             * @default 0
             */
            s3xx: number;
            /**
             * S4Xx
             * @description 4xx 请求数
             * @default 0
             */
            s4xx: number;
            /**
             * S5Xx
             * @description 5xx 请求数
             * @default 0
             */
            s5xx: number;
        };
        /**
         * MetricsTimeseriesResponse
         * @description 概览时序响应模型
         */
        MetricsTimeseriesResponse: {
            /** Range */
            range: string;
            /**
             * Step
             * @description 降采样步长（秒）
             */
            step: number;
            /** Generated At */
            generated_at: string;
            /**
             * Source
             * @description 数据来源：redis | memory
             */
            source: string;
            /** Points */
            points?: components["schemas"]["MetricsPoint"][];
        };
        /**
         * MonitoringEnabledRequest
         * @description 监控栈开关请求
         */
        MonitoringEnabledRequest: {
            /**
             * Enabled
             * @description 是否启用监控栈（启动/停止 Prometheus+Grafana）
             */
            enabled: boolean;
        };
        /**
         * MonitoringResponse
         * @description 监控栈状态响应模型
         */
        MonitoringResponse: {
            /** Available */
            available: boolean;
            /** Reason */
            reason?: string | null;
            /** Generated At */
            generated_at: string;
            grafana: components["schemas"]["MonitoringServiceState"];
            prometheus: components["schemas"]["MonitoringServiceState"];
        };
        /**
         * MonitoringServiceState
         * @description 监控栈单服务状态（Grafana / Prometheus）
         */
        MonitoringServiceState: {
            /** Running */
            running: boolean;
            /**
             * Configured
             * @default false
             */
            configured: boolean;
            /**
             * Ready
             * @default false
             */
            ready: boolean;
            /**
             * Entry
             * @default
             */
            entry: string;
            /** Container Id */
            container_id?: string | null;
        };
        /**
         * PRCommentCreateRequest
         * @description 创建 PR 评论请求体
         */
        PRCommentCreateRequest: {
            /**
             * Content
             * @description 评论内容
             */
            content: string;
            /**
             * File Path
             * @description 文件路径（行级评论）
             */
            file_path?: string | null;
            /**
             * Line Number
             * @description 行号（行级评论）
             */
            line_number?: number | null;
            /**
             * Commit Hash
             * @description 提交哈希（行级评论）
             */
            commit_hash?: string | null;
            /**
             * Parent Id
             * @description 父评论ID（回复）
             */
            parent_id?: string | null;
        };
        /**
         * PRCreateRequest
         * @description 创建 PR 请求体
         */
        PRCreateRequest: {
            /**
             * Title
             * @description PR 标题
             */
            title: string;
            /**
             * Description
             * @description PR 描述
             */
            description?: string | null;
            /**
             * Source Branch
             * @description 源分支
             */
            source_branch: string;
            /**
             * Target Branch
             * @description 目标分支
             */
            target_branch: string;
        };
        /**
         * PRLinkIssueRequest
         * @description 关联 Issue 请求体
         */
        PRLinkIssueRequest: {
            /**
             * Issue Number
             * @description 同仓库内的 Issue 编号
             */
            issue_number: number;
            /**
             * Closes On Merge
             * @description 合并 PR 时自动关闭该 Issue
             * @default true
             */
            closes_on_merge: boolean;
        };
        /**
         * PRMergeRequest
         * @description PR 合并请求体
         */
        PRMergeRequest: {
            /**
             * Merge Method
             * @description 合并方式：merge/squash/rebase
             * @default merge
             */
            merge_method: string;
            /**
             * Override
             * @description admin bypass：跳过保护分支裁决（需仓库 owner/admin，留审计）
             * @default false
             */
            override: boolean;
            /**
             * Override Reason
             * @description bypass 原因（写入 PR 活动流）
             */
            override_reason?: string | null;
        };
        /**
         * PRReviewRequest
         * @description PR 审查请求体
         */
        PRReviewRequest: {
            /**
             * Status
             * @description 审查状态：approved/changes_requested
             */
            status: string;
            /**
             * Comment
             * @description 审查意见
             */
            comment?: string | null;
        };
        /**
         * PRReviewersRequest
         * @description 请求评审请求体（user_ids 与 usernames 二选一或并用）
         */
        PRReviewersRequest: {
            /**
             * User Ids
             * @description 评审人用户ID列表
             */
            user_ids?: string[] | null;
            /**
             * Usernames
             * @description 评审人用户名列表
             */
            usernames?: string[] | null;
        };
        /**
         * PRUpdateRequest
         * @description 更新 PR 请求体
         */
        PRUpdateRequest: {
            /**
             * Title
             * @description PR 标题
             */
            title?: string | null;
            /**
             * Description
             * @description PR 描述
             */
            description?: string | null;
        };
        /**
         * PushCallback
         * @description hook 回调请求体。
         */
        PushCallback: {
            /**
             * Repo Path
             * @description 仓库相对路径 owner/repo（可带 .git 后缀）
             */
            repo_path: string;
            /** Updates */
            updates: components["schemas"]["RefUpdate"][];
        };
        /**
         * RefUpdate
         * @description 单个引用更新（hook 从 git stdin 解析后上报）。
         */
        RefUpdate: {
            /**
             * Ref
             * @description 引用名，如 refs/heads/main
             */
            ref: string;
            /**
             * Old
             * @description 推送前 OID（全零=新建）
             */
            old: string;
            /**
             * New
             * @description 推送后 OID（全零=删除）
             */
            new: string;
            /**
             * Is Force
             * @description 非快进更新（仅 pre-receive 需要；post-receive 恒 false）
             * @default false
             */
            is_force: boolean;
        };
        /**
         * RefreshTokenRequest
         * @description 刷新令牌请求体
         */
        RefreshTokenRequest: {
            /**
             * Refresh Token
             * @description 刷新令牌
             */
            refresh_token: string;
        };
        /**
         * RevokeInviteRequest
         * @description 邀请链接撤销请求体
         */
        RevokeInviteRequest: {
            /**
             * Token
             * @description 待撤销的邀请 token
             */
            token: string;
        };
        /**
         * RoomMemberMuteRequest
         * @description 设置本人对某一会话的静音状态
         */
        RoomMemberMuteRequest: {
            /** Muted */
            muted: boolean;
        };
        /**
         * SSHKeyResponse
         * @description SSH Key 响应体
         */
        SSHKeyResponse: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Name */
            name: string;
            /** Public Key */
            public_key: string;
            /** Fingerprint */
            fingerprint: string;
            /**
             * User Id
             * Format: uuid
             */
            user_id: string;
            /** Created At */
            created_at: string;
        };
        /**
         * SearchConfigPutRequest
         * @description 配置保存请求（``{values, version}`` + 密钥字段，与 agent PUT 同构）
         */
        SearchConfigPutRequest: {
            /**
             * Values
             * @description 可写白名单键的部分更新（白名单见 GET meta.editable_keys）
             */
            values: {
                [key: string]: unknown;
            };
            /**
             * Version
             * @description 乐观锁版本（GET meta.version，不符 → 409）
             */
            version: number;
            /**
             * Embedding Api Key
             * @description Embedding API key 明文（仅本次请求在内存使用，密文落库；缺省不修改）
             */
            embedding_api_key?: string | null;
            /**
             * Clear Embedding Api Key
             * @description 清除 DB 中保存的 Embedding API key（与 embedding_api_key 互斥）
             * @default false
             */
            clear_embedding_api_key: boolean;
        };
        /**
         * SetPermissionRequest
         * @description 会话成员权限覆盖请求体
         */
        SetPermissionRequest: {
            /**
             * Doc Key
             * @description 文档标识 repository_id:branch:path
             */
            doc_key: string;
            /**
             * User Id
             * Format: uuid
             * @description 被覆盖的成员用户ID
             */
            user_id: string;
            /**
             * Scope
             * @description 覆盖档位; null 表示清空覆盖回落到仓库角色
             */
            scope?: ("read" | "write") | null;
        };
        /**
         * StatusResponse
         * @description 状态响应模型
         */
        StatusResponse: {
            /** Status */
            status: string;
            /** Debug Mode */
            debug_mode: boolean;
            /** Uptime Seconds */
            uptime_seconds: number;
            /** Uptime Formatted */
            uptime_formatted: string;
            /** Version */
            version: string;
            /** Server Time */
            server_time: string;
            /** Process */
            process: {
                [key: string]: unknown;
            };
            /** Requests */
            requests: {
                [key: string]: unknown;
            };
            /** Git Operations */
            git_operations: {
                [key: string]: unknown;
            };
            /**
             * Schema State
             * @description 数据库 schema 版本（applied/head）
             */
            schema_state?: {
                [key: string]: unknown;
            };
        };
        /**
         * TagCreateRequest
         * @description 创建标签请求体
         */
        TagCreateRequest: {
            /**
             * Name
             * @description 标签名
             */
            name: string;
            /**
             * Target
             * @description 目标提交/分支，默认 HEAD
             */
            target?: string | null;
            /**
             * Message
             * @description 附注信息，为空则为轻量标签
             */
            message?: string | null;
        };
        /**
         * TestConnectionRequest
         * @description 连接探测请求（``{base_url, model?}``，provider 为附加便利字段）
         */
        TestConnectionRequest: {
            /**
             * Base Url
             * @description 覆盖 base_url；缺省取 provider 目录值/当前配置
             */
            base_url?: string | null;
            /**
             * Provider
             * @description 目录 provider id（可选）
             */
            provider?: string | null;
            /**
             * Model
             * @description 探活模型；缺省取 agent.model
             */
            model?: string | null;
        };
        /** UpdateBuildRequest */
        UpdateBuildRequest: {
            /** Status */
            status: string;
            /** Details Url */
            details_url?: string | null;
            /** Logs */
            logs?: string | null;
            /**
             * Log Entries
             * @description 增量日志行，seq 按 build 自增
             */
            log_entries?: components["schemas"]["LogEntryIn"][] | null;
        };
        /** UpdatePreferencesRequest */
        UpdatePreferencesRequest: {
            /** Email On Mention */
            email_on_mention?: boolean | null;
            /** Email On Pr Review */
            email_on_pr_review?: boolean | null;
            /** Email On Issue Comment */
            email_on_issue_comment?: boolean | null;
            /** Email On Pr Merge */
            email_on_pr_merge?: boolean | null;
            /** Email On Release */
            email_on_release?: boolean | null;
            /** In App On Mention */
            in_app_on_mention?: boolean | null;
            /** In App On Pr Review */
            in_app_on_pr_review?: boolean | null;
            /** In App On Issue Comment */
            in_app_on_issue_comment?: boolean | null;
        };
        /**
         * UpdateReleaseRequest
         * @description 更新 Release 请求体
         */
        UpdateReleaseRequest: {
            /**
             * Name
             * @description Release 标题
             */
            name?: string | null;
            /**
             * Description
             * @description Release 描述（Markdown）
             */
            description?: string | null;
            /**
             * Is Draft
             * @description 是否为草稿
             */
            is_draft?: boolean | null;
            /**
             * Is Prerelease
             * @description 是否为预发布版本
             */
            is_prerelease?: boolean | null;
        };
        /**
         * UpdateWebhookRequest
         * @description 更新 WebHook 请求体
         */
        UpdateWebhookRequest: {
            /**
             * Url
             * @description 回调 URL
             */
            url?: string | null;
            /**
             * Events
             * @description 订阅的事件列表
             */
            events?: string[] | null;
            /**
             * Secret
             * @description 签名密钥
             */
            secret?: string | null;
            /**
             * Content Type
             * @description Content-Type
             */
            content_type?: string | null;
            /**
             * Is Active
             * @description 是否激活
             */
            is_active?: boolean | null;
        };
        /**
         * UserCreateRequest
         * @description 创建用户请求体
         */
        UserCreateRequest: {
            /**
             * Username
             * @description 用户名
             */
            username: string;
            /**
             * Email
             * Format: email
             * @description 邮箱地址
             */
            email: string;
            /**
             * Password
             * @description 密码
             */
            password: string;
            /**
             * Full Name
             * @description 全名
             */
            full_name?: string | null;
            /**
             * Is Active
             * @description 是否激活
             * @default true
             */
            is_active: boolean;
        };
        /**
         * UserUpdateRequest
         * @description 更新用户请求体
         */
        UserUpdateRequest: {
            /**
             * Username
             * @description 用户名
             */
            username?: string | null;
            /**
             * Email
             * @description 邮箱地址
             */
            email?: string | null;
            /**
             * Full Name
             * @description 全名
             */
            full_name?: string | null;
            /**
             * Is Active
             * @description 是否激活
             */
            is_active?: boolean | null;
            /**
             * Is Admin
             * @description 是否管理员（仅管理员可设置）
             */
            is_admin?: boolean | null;
        };
        /** ValidationError */
        ValidationError: {
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
            /** Input */
            input?: unknown;
            /** Context */
            ctx?: Record<string, never>;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    root__get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    health_check_health_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_config_endpoint_api_app_config_get: {
        parameters: {
            query?: {
                /** @description 配置节名称 */
                section?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_config_endpoint_api_app_config_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfigUpdateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    reset_config_endpoint_api_app_config_reset_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigResponse"];
                };
            };
        };
    };
    validate_config_endpoint_api_app_config_validate_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                } | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_debug_mode_endpoint_api_app_debug_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DebugToggleRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DebugToggleResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_status_endpoint_api_app_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StatusResponse"];
                };
            };
        };
    };
    get_platform_stats_endpoint_api_v1_stats_platform_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_metrics_timeseries_endpoint_api_app_metrics_timeseries_get: {
        parameters: {
            query?: {
                /** @description 时间范围 */
                range?: "5m" | "30m" | "1h" | "6h" | "24h";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MetricsTimeseriesResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    shutdown_endpoint_api_app_shutdown_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActionResponse"];
                };
            };
        };
    };
    restart_endpoint_api_app_restart_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActionResponse"];
                };
            };
        };
    };
    get_log_info_endpoint_api_app_logs_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LogInfoResponse"];
                };
            };
        };
    };
    get_log_content_endpoint_api_app_logs_content_get: {
        parameters: {
            query?: {
                /** @description 日期 (YYYY-MM-DD)，默认为今天 */
                date?: string | null;
                /** @description 日志文件名，如 app, error */
                log_name?: string;
                /** @description 返回行数（1-5000） */
                lines?: number;
                /** @description 过滤级别 (debug/info/warning/error/critical) */
                level?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LogContentResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cleanup_logs_endpoint_api_app_logs_cleanup_post: {
        parameters: {
            query?: {
                /** @description 保留天数（1-365） */
                keep_days?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LogCleanupResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    query_audit_endpoint_api_app_audit_get: {
        parameters: {
            query?: {
                /** @description 向前回看的天数（含今天，1-90） */
                days?: number;
                /** @description 数据源：http=audit.log，activity=activities 表，all=合并 */
                source?: "all" | "http" | "activity";
                /** @description HTTP 方法过滤（仅 http 源） */
                method?: string | null;
                /** @description 用户名子串匹配（仅 http 源） */
                username?: string | null;
                /** @description 用户 ID 精确匹配（http 的 user_id / activity 的 actor_id） */
                user_id?: string | null;
                /** @description 请求路径子串匹配（仅 http 源） */
                path?: string | null;
                /** @description 响应状态码（仅 http 源） */
                status_code?: number | null;
                /** @description 日志级别（仅 http 源） */
                level?: string | null;
                /** @description 是否敏感操作（仅 http 源） */
                sensitive?: boolean | null;
                /** @description 业务动作精确匹配（仅 activity 源） */
                action?: string | null;
                /** @description 实体类型（仅 activity 源） */
                entity_type?: string | null;
                /** @description 关键词（http 匹配 path/用户名/IP，activity 匹配 action/details） */
                q?: string | null;
                /** @description 页码 */
                page?: number;
                /** @description 每页数量 */
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditListResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_components_endpoint_api_app_components_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ComponentsResponse"];
                };
            };
        };
    };
    get_monitoring_endpoint_api_app_monitoring_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MonitoringResponse"];
                };
            };
        };
    };
    set_monitoring_enabled_endpoint_api_app_monitoring_enabled_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MonitoringEnabledRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MonitoringResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    grafana_sso_endpoint_api_app_monitoring_grafana_sso_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GrafanaSsoResponse"];
                };
            };
        };
    };
    get_redis_status_endpoint_api_app_redis_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_redis_config_endpoint_api_app_redis_config_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_agent_config_endpoint_api_app_agent_config_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    put_agent_config_endpoint_api_app_agent_config_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentConfigPutRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_agent_providers_endpoint_api_app_agent_providers_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_agent_models_endpoint_api_app_agent_models_get: {
        parameters: {
            query?: {
                /** @description 目录 provider id（未知 id → agent_provider_not_found） */
                provider?: string | null;
                /** @description 覆盖 base_url（配置级校验，优先于 provider 目录值） */
                base_url?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    test_agent_connection_endpoint_api_app_agent_test_connection_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestConnectionRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_agent_key_status_endpoint_api_app_agent_key_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_agent_usage_endpoint_api_app_agent_usage_get: {
        parameters: {
            query?: {
                /** @description 统计窗口（天，UTC 日界） */
                days?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_search_config_endpoint_api_app_search_config_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    put_search_config_endpoint_api_app_search_config_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SearchConfigPutRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_search_index_overview_endpoint_api_app_search_index_overview_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_repository_tree_api_v1_repositories__repo_id__tree_get: {
        parameters: {
            query?: {
                /** @description 分支名或提交SHA */
                ref?: string;
                /** @description 子目录路径 */
                path?: string;
                /** @description 是否附带每个条目（文件/目录）最近提交信息 */
                last_commit?: boolean;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_blob_api_v1_repositories__repo_id__blob_get: {
        parameters: {
            query: {
                /** @description 文件路径 */
                path: string;
                /** @description 分支名或提交SHA */
                ref?: string;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_repository_file_api_v1_repositories__repo_id__contents__file_path__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                file_path: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FileCommitRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_repository_file_api_v1_repositories__repo_id__contents__file_path__delete: {
        parameters: {
            query?: {
                /** @description 目标分支, 默认仓库默认分支 */
                branch?: string | null;
            };
            header?: never;
            path: {
                repo_id: string;
                file_path: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    move_repository_file_api_v1_repositories__repo_id__contents_move_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FileMoveRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_commits_api_v1_repositories__repo_id__commits_get: {
        parameters: {
            query?: {
                /** @description 分支名 */
                ref?: string;
                /** @description 特定文件路径 */
                path?: string | null;
                /** @description 页码 */
                page?: number;
                /** @description 每页数量 */
                per_page?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_commit_api_v1_repositories__repo_id__commits_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_diff_api_v1_repositories__repo_id__diff_get: {
        parameters: {
            query: {
                /** @description 对比提交SHA */
                head: string;
                /** @description 基准提交SHA */
                base?: string | null;
                /** @description 特定文件路径 */
                path?: string | null;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_blame_api_v1_repositories__repo_id__blame_get: {
        parameters: {
            query: {
                /** @description 文件路径 */
                path: string;
                /** @description 分支名或提交SHA */
                ref?: string;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_graph_api_v1_repositories__repo_id__graph_get: {
        parameters: {
            query?: {
                /** @description 起始分支名或提交SHA */
                ref?: string;
                /** @description 最大节点数 */
                limit?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_compare_api_v1_repositories__repo_id__compare_get: {
        parameters: {
            query: {
                /** @description 基准分支/标签/提交 */
                base: string;
                /** @description 目标分支/标签/提交 */
                head: string;
                /** @description 特定文件路径 */
                path?: string | null;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_readme_api_v1_repositories__repo_id__readme_get: {
        parameters: {
            query?: {
                /** @description 分支名或提交SHA */
                ref?: string;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_file_symbols_api_v1_repositories__repo_id__symbols_get: {
        parameters: {
            query: {
                /** @description 文件路径 */
                path: string;
                /** @description 分支名或提交SHA */
                ref?: string;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    detect_repository_file_language_api_v1_repositories__repo_id__language_get: {
        parameters: {
            query: {
                /** @description 文件路径 */
                path: string;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    login_api_v1_auth_login_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    refresh_token_api_v1_auth_refresh_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RefreshTokenRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    logout_api_v1_auth_logout_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["LogoutRequest"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    collab_auth_api_v1_collab_auth_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CollabAuthRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    collab_doc_api_v1_collab_doc_get: {
        parameters: {
            query: {
                docKey: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    collab_save_api_v1_collab_save_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CollabSaveRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    pre_receive_api_v1_git_internal_pre_receive_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PushCallback"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_receive_api_v1_git_internal_post_receive_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PushCallback"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    oauth_login_api_v1_auth__provider__login_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    oauth_callback_api_v1_auth__provider__callback_get: {
        parameters: {
            query: {
                code: string;
                state: string;
            };
            header?: never;
            path: {
                provider: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_linked_accounts_api_v1_users_me_oauth_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    unlink_account_api_v1_users_me_oauth__provider__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_users_api_v1_users_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    create_user_api_v1_users_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UserCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_current_user_info_api_v1_users_me_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_current_user_dashboard_api_v1_users_me_dashboard_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_current_user_pull_requests_api_v1_users_me_pull_requests_get: {
        parameters: {
            query?: {
                status?: string | null;
                page?: number;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_current_user_issues_api_v1_users_me_issues_get: {
        parameters: {
            query?: {
                status?: string | null;
                page?: number;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_current_user_review_requests_api_v1_users_me_review_requests_get: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_current_user_builds_api_v1_users_me_builds_get: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_current_user_contributors_api_v1_users_me_contributors_get: {
        parameters: {
            query?: {
                days?: number;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    change_current_user_password_api_v1_users_me_password_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChangePasswordRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    upload_current_user_avatar_api_v1_users_me_avatar_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_upload_current_user_avatar_api_v1_users_me_avatar_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_user_avatar_file_api_v1_users__user_id__avatar_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_user_api_v1_users__user_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_user_api_v1_users__user_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UserUpdateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_user_api_v1_users__user_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    admin_reset_user_password_api_v1_users__user_id__password_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminResetPasswordRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_members_api_v1_repositories__repo_id__members_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    add_repository_member_api_v1_repositories__repo_id__members_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_member_api_v1_repositories__repo_id__members__user_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_repository_member_api_v1_repositories__repo_id__members__user_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_repository_member_api_v1_repositories__repo_id__members__user_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_member_role_api_v1_repositories__repo_id__members__user_id__role_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    activate_repository_member_api_v1_repositories__repo_id__members__user_id__activate_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    deactivate_repository_member_api_v1_repositories__repo_id__members__user_id__deactivate_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    check_member_permission_api_v1_repositories__repo_id__members__user_id__permission_get: {
        parameters: {
            query: {
                permission: string;
            };
            header?: never;
            path: {
                repo_id: string;
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_repository_forks_api_v1_repositories__repo_id__forks_get: {
        parameters: {
            query?: {
                /** @description 页码 */
                page?: number;
                /** @description 每页数量 */
                limit?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    fork_repository_api_v1_repositories__repo_id__forks_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ForkCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_fork_source_api_v1_repositories__repo_id__forks_source_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    sync_fork_api_v1_repositories__repo_id__forks_sync_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_star_status_api_v1_repositories__repo_id__star_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    star_repository_api_v1_repositories__repo_id__star_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    unstar_repository_api_v1_repositories__repo_id__star_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_stargazers_api_v1_repositories__repo_id__stargazers_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_watch_status_api_v1_repositories__repo_id__watch_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    watch_repository_api_v1_repositories__repo_id__watch_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    unwatch_repository_api_v1_repositories__repo_id__watch_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_watchers_api_v1_repositories__repo_id__watchers_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    issue_collab_invite_api_v1_repositories__repo_id__collab_invites_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IssueInviteRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    revoke_collab_invite_api_v1_repositories__repo_id__collab_invites_revoke_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RevokeInviteRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_session_permission_api_v1_repositories__repo_id__collab_sessions_permission_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetPermissionRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    kick_session_member_api_v1_repositories__repo_id__collab_sessions_kick_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["KickRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_labels_api_v1_repositories__repo_id__labels_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_label_api_v1_repositories__repo_id__labels_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_label_api_v1_repositories__repo_id__labels__label_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                label_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_label_api_v1_repositories__repo_id__labels__label_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                label_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    add_label_to_repository_api_v1_repositories__repo_id__labels__label_id__add_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                label_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_label_from_repository_api_v1_repositories__repo_id__labels__label_id__remove_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                label_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_discussion_comments_api_v1_repositories__repo_id__discussions_get: {
        parameters: {
            query?: {
                /** @description 按文件路径过滤 */
                file_path?: string | null;
                /** @description 按分支过滤 */
                branch?: string | null;
                /** @description 按行号过滤 */
                line_number?: number | null;
                /** @description 是否包含已解决评论 */
                include_resolved?: boolean;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_discussion_comment_api_v1_repositories__repo_id__discussions_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FileCommentCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_discussion_comment_api_v1_repositories__repo_id__discussions__comment_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                comment_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    resolve_discussion_comment_api_v1_repositories__repo_id__discussions__comment_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                comment_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FileCommentResolveRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    batch_api_v1_repositories__repo_id__lfs_objects_batch_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    download_object_api_v1_repositories__repo_id__lfs_objects__oid__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                oid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    upload_object_api_v1_repositories__repo_id__lfs_objects__oid__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                oid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_object_api_v1_repositories__repo_id__lfs_objects__oid__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                oid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    verify_object_api_v1_repositories__repo_id__lfs_objects__oid__verify_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                oid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    batch_by_path_api_v1_lfs__owner___repo_name__batch_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                owner: string;
                repo_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_branches_api_v1_repositories__repo_id__branches_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_branch_api_v1_repositories__repo_id__branches_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_default_branch_api_v1_repositories__repo_id__branches_default_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_branch_api_v1_repositories__repo_id__branches__branch_name__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                branch_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_branch_api_v1_repositories__repo_id__branches__branch_name__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                branch_name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_branch_api_v1_repositories__repo_id__branches__branch_name__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                branch_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_default_branch_api_v1_repositories__repo_id__branches__branch_name__default_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                branch_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    protect_branch_api_v1_repositories__repo_id__branches__branch_name__protect_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                branch_name: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                } | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    unprotect_branch_api_v1_repositories__repo_id__branches__branch_name__unprotect_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                branch_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    check_branch_protection_api_v1_repositories__repo_id__branches__branch_name__protection_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                branch_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_commit_history_api_v1_repositories__repo_id__commits_history_get: {
        parameters: {
            query?: {
                branch_name?: string | null;
                limit?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    count_repo_commits_api_v1_repositories__repo_id__commits_count_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_commits_api_v1_repositories__repo_id__commits_search_get: {
        parameters: {
            query: {
                query: string;
                limit?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_commits_by_author_api_v1_repositories__repo_id__commits_author_get: {
        parameters: {
            query: {
                /** @description 作者邮箱 */
                author_email: string;
                limit?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_latest_commit_api_v1_repositories__repo_id__commits_latest_get: {
        parameters: {
            query?: {
                branch_name?: string | null;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_commit_by_hash_api_v1_repositories__repo_id__commits__commit_hash__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                commit_hash: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_branch_commits_api_v1_repositories__repo_id__branches__branch_name__commits_get: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
            };
            header?: never;
            path: {
                repo_id: string;
                branch_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    count_branch_commits_api_v1_repositories__repo_id__branches__branch_name__commits_count_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                branch_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_repository_tags_api_v1_repositories__repo_id__tags_get: {
        parameters: {
            query?: {
                /** @description glob 过滤，如 v1.* */
                pattern?: string | null;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_repository_tag_api_v1_repositories__repo_id__tags_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TagCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_tag_api_v1_repositories__repo_id__tags__tag_name__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                tag_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_repository_tag_api_v1_repositories__repo_id__tags__tag_name__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                tag_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_pull_requests_api_v1_repositories__repo_id__pull_requests_get: {
        parameters: {
            query?: {
                /** @description 状态筛选：open/merged/closed */
                status?: string | null;
                /** @description 作者ID筛选 */
                author?: string | null;
                /** @description 页码 */
                page?: number;
                /** @description 每页数量 */
                limit?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_pull_request_api_v1_repositories__repo_id__pull_requests_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PRCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_pull_request_api_v1_repositories__repo_id__pull_requests__pr_number__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_pull_request_api_v1_repositories__repo_id__pull_requests__pr_number__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PRUpdateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    close_pull_request_api_v1_repositories__repo_id__pull_requests__pr_number__close_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    merge_pull_request_api_v1_repositories__repo_id__pull_requests__pr_number__merge_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PRMergeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_pr_comments_api_v1_repositories__repo_id__pull_requests__pr_number__comments_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_pr_comment_api_v1_repositories__repo_id__pull_requests__pr_number__comments_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PRCommentCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_pr_review_api_v1_repositories__repo_id__pull_requests__pr_number__reviews_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PRReviewRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_pr_diff_api_v1_repositories__repo_id__pull_requests__pr_number__diff_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_pr_file_diff_api_v1_repositories__repo_id__pull_requests__pr_number__diff__file_path__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
                file_path: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_pr_linked_issues_api_v1_repositories__repo_id__pull_requests__pr_number__issues_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    link_pr_issue_api_v1_repositories__repo_id__pull_requests__pr_number__issues_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PRLinkIssueRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    unlink_pr_issue_api_v1_repositories__repo_id__pull_requests__pr_number__issues__issue_number__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
                issue_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_pr_reviewers_api_v1_repositories__repo_id__pull_requests__pr_number__reviewers_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    request_pr_reviewers_api_v1_repositories__repo_id__pull_requests__pr_number__reviewers_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PRReviewersRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_pr_reviewer_api_v1_repositories__repo_id__pull_requests__pr_number__reviewers__reviewer_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
                reviewer_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_labels_api_v1_repositories__repo_id__pr_labels_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_label_api_v1_repositories__repo_id__pr_labels_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_label_api_v1_repositories__repo_id__pr_labels__label_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                label_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_label_api_v1_repositories__repo_id__pr_labels__label_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                label_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    add_label_to_pr_api_v1_repositories__repo_id__pull_requests__pr_number__labels__label_id__post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
                label_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_label_from_pr_api_v1_repositories__repo_id__pull_requests__pr_number__labels__label_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                pr_number: number;
                label_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_prs_by_label_api_v1_repositories_pr_labels__label_id__pull_requests_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                label_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_releases_api_v1_repositories__repo_id__releases_get: {
        parameters: {
            query?: {
                /** @description 是否包含草稿 */
                include_drafts?: boolean;
                /** @description 是否包含预发布版本 */
                include_prereleases?: boolean;
                /** @description 页码 */
                page?: number;
                /** @description 每页数量 */
                limit?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_release_api_v1_repositories__repo_id__releases_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateReleaseRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_release_api_v1_repositories__repo_id__releases__release_number__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                release_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_release_api_v1_repositories__repo_id__releases__release_number__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                release_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_release_api_v1_repositories__repo_id__releases__release_number__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                release_number: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateReleaseRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_release_by_tag_api_v1_repositories__repo_id__releases_tag__tag_name__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                tag_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    add_release_asset_api_v1_repositories__repo_id__releases__release_number__assets_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                release_number: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AddAssetRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    upload_release_asset_api_v1_repositories__repo_id__releases__release_number__assets_upload_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                release_number: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_upload_release_asset_api_v1_repositories__repo_id__releases__release_number__assets_upload_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    download_release_asset_api_v1_repositories__repo_id__releases__release_number__assets__asset_id__download_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                release_number: number;
                asset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_release_asset_api_v1_repositories__repo_id__releases__release_number__assets__asset_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                release_number: number;
                asset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_issues_api_v1_repositories__repo_id__issues_get: {
        parameters: {
            query?: {
                /** @description 状态筛选：open/closed */
                status?: string | null;
                /** @description 标签名称筛选 */
                label?: string | null;
                /** @description 指派人ID筛选 */
                assignee?: string | null;
                /** @description 作者ID筛选 */
                author?: string | null;
                /** @description 页码 */
                page?: number;
                /** @description 每页数量 */
                limit?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_issue_api_v1_repositories__repo_id__issues_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IssueCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    filter_issues_api_v1_repositories__repo_id__issues_filter_post: {
        parameters: {
            query?: {
                /** @description 排序字段 */
                sort_by?: string;
                /** @description 排序方向 */
                sort_order?: string;
                /** @description 页码 */
                page?: number;
                /** @description 每页数量 */
                per_page?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IssueFilterRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    batch_close_issues_api_v1_repositories__repo_id__issues_batch_close_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BatchIssueNumbersRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    batch_reopen_issues_api_v1_repositories__repo_id__issues_batch_reopen_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BatchIssueNumbersRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    batch_update_issues_api_v1_repositories__repo_id__issues_batch_patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BatchUpdateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    batch_add_labels_api_v1_repositories__repo_id__issues_batch_labels_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BatchLabelsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    batch_remove_labels_api_v1_repositories__repo_id__issues_batch_labels_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BatchLabelsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_issue_api_v1_repositories__repo_id__issues__issue_number__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                issue_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_issue_api_v1_repositories__repo_id__issues__issue_number__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                issue_number: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IssueUpdateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    close_issue_api_v1_repositories__repo_id__issues__issue_number__close_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                issue_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    reopen_issue_api_v1_repositories__repo_id__issues__issue_number__reopen_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                issue_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_issue_comments_api_v1_repositories__repo_id__issues__issue_number__comments_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                issue_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_issue_comment_api_v1_repositories__repo_id__issues__issue_number__comments_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                issue_number: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IssueCommentCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_issue_linked_prs_api_v1_repositories__repo_id__issues__issue_number__pull_requests_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                issue_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    link_issue_pr_api_v1_repositories__repo_id__issues__issue_number__pull_requests_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                issue_number: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IssueLinkPRRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    unlink_issue_pr_api_v1_repositories__repo_id__issues__issue_number__pull_requests__pr_number__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                issue_number: number;
                pr_number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_ssh_keys_api_v1_keys_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SSHKeyResponse"][];
                };
            };
        };
    };
    add_ssh_key_api_v1_keys_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AddSSHKeyRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SSHKeyResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_ssh_key_api_v1_keys__key_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                key_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_webhooks_api_v1_repositories__repo_id__webhooks_get: {
        parameters: {
            query?: {
                /** @description 页码 */
                page?: number;
                /** @description 每页数量 */
                limit?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_webhook_api_v1_repositories__repo_id__webhooks_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateWebhookRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_webhook_api_v1_repositories__repo_id__webhooks__webhook_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                webhook_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_webhook_api_v1_repositories__repo_id__webhooks__webhook_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                webhook_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_webhook_api_v1_repositories__repo_id__webhooks__webhook_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                webhook_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateWebhookRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    test_webhook_api_v1_repositories__repo_id__webhooks__webhook_id__test_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                webhook_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_webhook_deliveries_api_v1_repositories__repo_id__webhooks__webhook_id__deliveries_get: {
        parameters: {
            query?: {
                /** @description 页码 */
                page?: number;
                /** @description 每页数量 */
                limit?: number;
            };
            header?: never;
            path: {
                repo_id: string;
                webhook_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_webhook_delivery_api_v1_repositories__repo_id__webhooks__webhook_id__deliveries__delivery_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                webhook_id: string;
                delivery_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repo_stats_api_v1_repositories__repo_id__stats_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_activities_api_v1_repositories__repo_id__activities_get: {
        parameters: {
            query?: {
                /** @description 实体类型过滤 */
                entity_type?: string;
                /** @description 操作者过滤 */
                actor_id?: string;
                page?: number;
                limit?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_notifications_api_v1_notifications_get: {
        parameters: {
            query?: {
                /** @description 只获取未读通知 */
                unread_only?: boolean;
                /** @description 跳过条数 */
                skip?: number;
                /** @description 每页条数 */
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_notification_api_v1_notifications_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateNotificationRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_unread_count_api_v1_notifications_unread_count_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    mark_as_read_api_v1_notifications__notification_id__read_patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                notification_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    mark_all_as_read_api_v1_notifications_read_all_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_preferences_api_v1_notifications_preferences_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    update_preferences_api_v1_notifications_preferences_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdatePreferencesRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_notification_api_v1_notifications__notification_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                notification_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_room_api_v1_repositories__repo_id__room_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_rooms_api_v1_rooms_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_room_members_api_v1_rooms__room_id__members_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                room_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_room_member_muted_api_v1_rooms__room_id__members_me_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                room_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RoomMemberMuteRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_room_api_v1_rooms__room_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                room_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    upload_room_attachment_api_v1_rooms__room_id__attachments_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                room_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_upload_room_attachment_api_v1_rooms__room_id__attachments_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    download_room_attachment_api_v1_attachments__room_id___stored_name__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                room_id: string;
                stored_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_dms_api_v1_dm_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_or_create_dm_api_v1_dm_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DMCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_unread_counts_api_v1_rooms_unread_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    mark_room_read_api_v1_rooms__room_id__read_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                room_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_room_messages_api_v1_rooms__room_id__messages_get: {
        parameters: {
            query?: {
                before?: string | null;
                limit?: number;
                /** @description 按内容关键词筛选消息 */
                q?: string | null;
            };
            header?: never;
            path: {
                room_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_messages_api_v1_messages_search_get: {
        parameters: {
            query: {
                /** @description 搜索关键词 */
                q: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_message_api_v1_rooms__room_id__messages__msg_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                room_id: string;
                msg_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    add_message_reaction_api_v1_rooms__room_id__messages__msg_id__reactions_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                room_id: string;
                msg_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_message_reaction_api_v1_rooms__room_id__messages__msg_id__reactions_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                room_id: string;
                msg_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_code_api_v1_repositories__repo_id__search_get: {
        parameters: {
            query: {
                /** @description 搜索关键词 */
                q: string;
                /** @description 限制搜索目录 */
                path?: string;
                /** @description 分支/标签/提交，缺省为默认分支 */
                ref?: string;
                /** @description 是否叠加语义检索（缺省取 search.embedding_enabled） */
                semantic?: boolean;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    find_symbol_definition_api_v1_repositories__repo_id__symbols__name__definition_get: {
        parameters: {
            query?: {
                /** @description 限制搜索目录 */
                path?: string;
                /** @description 排除测试文件 */
                exclude_tests?: boolean;
                /** @description 分支/标签/提交；缺省为默认分支（走块级索引） */
                ref?: string;
            };
            header?: never;
            path: {
                repo_id: string;
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    find_symbol_usages_api_v1_repositories__repo_id__symbols__name__usages_get: {
        parameters: {
            query?: {
                /** @description 限制搜索目录 */
                path?: string;
                /** @description 排除测试文件 */
                exclude_tests?: boolean;
                /** @description 最大返回数（上限 = search.max_results） */
                max_results?: number;
                /** @description 分支/标签/提交；缺省为默认分支（走块级索引） */
                ref?: string;
            };
            header?: never;
            path: {
                repo_id: string;
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_index_status_api_v1_repositories__repo_id__search_index_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_reindex_api_v1_repositories__repo_id__search_reindex_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    global_search_code_api_v1_search_code_get: {
        parameters: {
            query: {
                /** @description 搜索关键词 */
                q: string;
                /** @description 限制搜索目录 */
                path?: string;
                /** @description 分支/标签/提交，缺省为各仓库默认分支 */
                ref?: string;
                /** @description 最大返回结果数（上限 = search.max_results） */
                max_results?: number;
                /** @description 每个仓库最大结果数 */
                per_repo_max?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    global_search_api_v1_search_global_get: {
        parameters: {
            query: {
                /** @description 搜索关键词 */
                q: string;
                /** @description 每类结果最大返回数 */
                per_type?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_agent_jobs_api_v1_repositories__repo_id__agent_jobs_get: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_agent_job_api_v1_repositories__repo_id__agent_jobs_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateJobRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_agent_job_api_v1_repositories__repo_id__agent_jobs__job_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_agent_job_steps_api_v1_repositories__repo_id__agent_jobs__job_id__steps_get: {
        parameters: {
            query?: {
                after_seq?: number;
            };
            header?: never;
            path: {
                repo_id: string;
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cancel_agent_job_api_v1_repositories__repo_id__agent_jobs__job_id__cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    approve_agent_tool_call_api_v1_repositories__repo_id__agent_jobs__job_id__approve_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ApprovalRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    reject_agent_tool_call_api_v1_repositories__repo_id__agent_jobs__job_id__reject_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ApprovalRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_builds_api_v1_repositories__repo_id__builds_get: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
                /** @description 按分支过滤（PR 详情关联构建场景） */
                branch?: string | null;
                /** @description 按状态过滤 */
                status?: string | null;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_build_api_v1_repositories__repo_id__builds_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateBuildRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_build_api_v1_repositories__repo_id__builds__build_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                build_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_build_api_v1_repositories__repo_id__builds__build_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
                build_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateBuildRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_build_logs_api_v1_repositories__repo_id__builds__build_id__logs_get: {
        parameters: {
            query?: {
                /** @description 增量边界: 只返回 seq>after_seq 的日志行 */
                after_seq?: number;
            };
            header?: never;
            path: {
                repo_id: string;
                build_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repositories_api_v1_repositories_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    create_repository_api_v1_repositories_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_public_repositories_api_v1_repositories_public_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_repositories_by_user_api_v1_repositories_user__user_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_api_v1_repositories__repo_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_repository_api_v1_repositories__repo_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_repository_api_v1_repositories__repo_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    check_repository_access_api_v1_repositories__repo_id__access_get: {
        parameters: {
            query: {
                user_id: string;
            };
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    archive_repository_api_v1_repositories__repo_id__archive_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    unarchive_repository_api_v1_repositories__repo_id__unarchive_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                repo_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_repository_by_path_api_v1_repo__owner___repo__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                owner: string;
                repo: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    debug_status_api_v1_debug_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DebugStatusResponse"];
                };
            };
        };
    };
    init_database_api_v1_debug_initdb_post: {
        parameters: {
            query?: {
                force?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InitDbResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    init_config_api_v1_debug_initconf_post: {
        parameters: {
            query?: {
                force?: boolean;
                backup?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InitConfResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_error_info_api_v1_errors_info__error_code__get: {
        parameters: {
            query?: {
                message?: string | null;
                error_type?: string | null;
                details?: string | null;
                request_id?: string | null;
            };
            header?: never;
            path: {
                error_code: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorInfoResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_recent_errors_api_v1_errors_recent_get: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorLogEntry"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    report_error_api_v1_errors_report_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
}
