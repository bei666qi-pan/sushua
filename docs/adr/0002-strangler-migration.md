# ADR 0002: 使用绞杀者迁移而非整体重写

- 状态：Accepted
- 日期：2026-08-31

## 背景

现有 Next.js 应用已经提供上传、确认、旧链接、刷题和讲解闭环，同时生产数据仍依赖 SQLite。一次性替换数据库、身份、解析、队列和学习状态会同时破坏旧路径、回滚能力和因果验证。

## 决定

- 保留现有 Next.js 根目录和旧 `/b/[slug]`、`/api/banks*`、`/api/parse`、`/api/explain` 路径。
- 通过深模块、兼容 Adapter、影子写入、checksum 对账和逐 Workspace Feature Flag 迁移。
- 每个 Phase 独立验收和回滚；关闭 Flag 不删除已写入的新数据。
- 后续 Node 代码以小规模 workspaces 增加 `apps/job-worker` 与 `packages/*`，不搬迁 Web 根目录。

## 结果

- 迁移期间会暂时存在双实现和对账成本。
- 旧路径可以持续服务并作为回滚面。
- 新服务不能把 Redis 或进程内状态当作业务事实源。
