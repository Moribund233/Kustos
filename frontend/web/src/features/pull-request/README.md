# pull-request

Pull Request 详情：描述、评审发现、diff、行内讨论、检查、评审人、关联 Issue、合并。

- 计划路由：`/:owner/:repo/pull/:number`
- 后端接口：`GET/PATCH /api/v1/repositories/{repo_id}/pull-requests/{pr_number}`、`/reviews`、`/comments`、`/diff`、`/issues`（关联 Issue）、`/reviewers`（评审请求）
- 边界：合并裁决由后端 `enforce_merge_protection` 决定；前端只展示理由与所需条件，不自行判定可合并。
