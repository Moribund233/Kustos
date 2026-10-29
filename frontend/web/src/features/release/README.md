# release

仓库发布版本：列表、创建、草稿与预发布标记。

- 路由：`/releases`（仓库级；从代码页的仓库标签栏进入）
- 后端接口：`release_controller`（`GET/POST /repositories/{repo_id}/releases`）
- 边界：创建时后端同时打 Git 标签；附件上传与单条详情页尚未展开，需要文件选择与上传进度。
