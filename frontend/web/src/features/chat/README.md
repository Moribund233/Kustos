# chat

仓库频道与实时协作：消息、@kustos-agent、在线状态、共享文档。

- 计划路由：`/:owner/:repo/chat`
- 后端接口：WebSocket（房间/消息/在线）、`collab` 网关（CRDT 文档）、`room_controller`
- 边界：房间成员身份跟随仓库成员关系，没有独立的「房间管理员」角色。
