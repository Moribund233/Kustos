# code

仓库代码浏览：文件树、分支切换、符号大纲、行内评论、单文件提问。

- 计划路由：`/:owner/:repo/code`、`/:owner/:repo/code/:path`
- 后端接口：`repository_browser_controller`（文件树/blob/提交/diff/symbols）、`search_controller`（定义/引用）
- 边界：语义检索与索引状态需要读权限；「索引重建」不是管理员操作。
