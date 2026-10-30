# services

按**领域**切分的服务层。每个目录一个领域，与前端 `src/features/` 的切分口径一致
——两边看同一个「领域」时，进出的心智模型是同一套。

```
app/services/<domain>/
└── <module>.py      # 该领域的服务实现
```

## 领域划分

| 包 | 领域 | 覆盖 |
| --- | --- | --- |
| `repository/` | 仓库与 Git 对象 | 仓库本体、浏览器、分支、提交、成员、密钥、fork/star/watch、语言统计、活动审计 |
| `collaboration/` | 协作内容 | Issue、Pull Request（评审/标签/关联/活动子域）、标签、行内评论、Release、协作邀请、docKey 解析、统计看板 |
| `messaging/` | 消息 | 站内通知、通知偏好、聊天附件 |
| `lfs/` | Git LFS | 业务逻辑、存储后端、短时效 transfer token |
| `search/` | 搜索 | 代码检索主服务、搜索/embedding 管理面 |
| `integration/` | 外部集成 | Git hooks 回调、Webhook 投递与签名、CI 构建记录 |
| `platform/` | 平台运维 | 应用控制、配置管理、数据库重置、指标与监控栈、容器编排、保留策略、worker 注册表 |
| `agent/` | 内置 Agent | 会话编排、工具执行、provider 适配、配额 |
| `auth/` | 认证与用户 | 令牌生命周期、撤销位图、OAuth 适配器、用户账号 |
| `indexing/` | 索引 | 源码切块、embedding provider |
| `realtime/` | 实时 | 事件总线、presence、房间、聊天、WS 出站推送 |

## 约定

1. **子包 `__init__` 保持轻量**：不 re-export 具体模块。导入请写全路径
   （`from app.services.repository.repository_service import RepositoryService`），
   避免子包之间形成循环导入。
2. **跨领域调用写全路径**：领域之间可以调用，但要让依赖方向在 import 语句里
   **看得见**——不要在一个领域里 `from app.services import <另一个领域>`。
3. **新服务先找归属**：加新文件前先在上面的表里找领域；找不到就新增一个包，
   并在这里登记。不要把新服务丢回 `services/` 顶层。
4. **命名**：`<名词>_service.py`（服务）、`<名词>_store.py`（存储）、
   `<名词>_cache.py`（缓存）、`<名词>_state.py`（进程内状态）。
   同一后缀代表同一种职责，别混用。

## 守护

`backend/tests/test_layer_boundary.py` 用 AST 断言层间依赖白名单
（`api → services → middleware → core → models → utils`），并带一条只收不放的
「延迟导入棘轮」。新增跨层导入会让它立刻变红。
