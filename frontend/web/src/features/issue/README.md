# issue

Issue 分诊：列表、筛选、详情、评论、标签、指派。

- 计划路由：`/:owner/:repo/issues`、`/:owner/:repo/issues/:number`
- 后端接口：`issue_controller`（列表/过滤/批量/评论）、`GET /api/v1/repositories/{repo_id}/issues/{issue_number}/pull-requests`
- 边界：Kustos triage 是只读摘要，来源于 Agent 作业，不落库为独立实体。
