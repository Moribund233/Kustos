# overview

工作台首页（Watch）。展示个人待办队列、活动流、仓库状态。

- 计划路由：`/`（根路由下的 index）
- 后端接口：`GET /api/v1/repositories`、`GET /api/v1/users/me/dashboard`、`GET /api/v1/activities`
- 边界：只显示当前用户可见的数据；实例级健康（组件、Redis、uptime）属于管理员面，不在此出现。
