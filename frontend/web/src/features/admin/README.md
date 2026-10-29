# admin

实例管理面（仅全局管理员）：组件状态、监控栈、用户与角色、配置、审计、日志。

- 计划路由：`/admin/*`
- 后端接口：`/api/app/*`（`app_controller`、`agent_admin_controller`、`search_admin_controller`）
- 边界：网关按 `KUSTOS_ADMIN_ALLOWED_SOURCES` 限制来源，留空即拒绝全部；前端只做二次提示。
