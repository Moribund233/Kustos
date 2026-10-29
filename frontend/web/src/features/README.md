# features

按后端领域切分的功能目录。每个目录一个领域，页面、查询与领域内组件都放在对应目录，
不在 `components/` 里堆业务组件。

```
src/features/<domain>/
├── api.ts        # 该领域的请求封装（基于 lib/api 的 openapi client）
├── queries.ts    # React Query hooks
├── components/   # 领域内组件
└── pages/        # 路由页面
```

跨领域复用的东西放 `src/components/`（只放展示型组件）与 `src/lib/`（基础设施）。
