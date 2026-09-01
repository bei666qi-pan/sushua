# Feature Flags

所有新能力在 `src/lib/feature-flags.ts` 统一登记，默认关闭。环境变量格式为 `FEATURE_<FLAG_NAME_UPPERCASE>`，只有 `1`、`true`、`yes`、`on`（大小写不敏感）可开启；空值和未知值均失败关闭。

Phase 0 只建立注册表。Phase 1 开始由页面和 API 消费开关；关闭时必须在初始化数据库、SMTP 或密钥之前返回 404。每个入口都必须同时定义：

- 开启范围和负责人；
- 依赖的迁移版本；
- 关闭后的读写行为；
- 已生成数据的保留策略；
- 灰度与回滚验证。

| Flag | Phase 1 开启范围 | 关闭行为 | 数据保留 |
|---|---|---|---|
| `postgres_shadow_write` | 旧 `POST /api/banks`、`PATCH/DELETE /api/banks/[slug]` 在 SQLite 主写成功后镜像 Workspace/mapping；仅在 `0007`、函数授权、基线 backfill 和 reconciliation 就绪后开启 | 完全保持旧 SQLite 响应和读写行为，不初始化 PostgreSQL；不包含 `shadow_sync` 响应字段 | 已镜像 Workspace/mapping 保留，关闭 Flag 不回删 |
| `guest_claim` | 邮箱 OTP、游客 bootstrap、Workspace 认领、旧 `/b/[slug]` owner key 认领 | `/login`、`/api/auth/*`、认领 API 为 404；不初始化 Auth/Guest/legacy claim 服务 | 已有用户、游客与 legacy mapping 保留 |
| `workspace_library` | `/workspaces`、`GET/POST /api/v1/workspaces` | 页面和 API 为 404；旧 `/b/[slug]` 不变 | 已有 Workspace 保留 |
| `async_ingestion` | `POST /api/v1/uploads` 创建 Document 草稿并返回 S3 multipart 直传计划；`POST /api/v1/uploads/{asset_id}/complete` 校验对象、原子创建 `file.scan` Job，再以同一 Job UUID 投递 BullMQ；仅在迁移 `0013`、RLS Web 角色、函数授权、S3 和 Redis 配置就绪后开启 | 两个 API 都在初始化 Auth、PostgreSQL、Storage 或 Redis 前返回 404；旧 `/api/parse` 不变 | 已有 Document、DocumentVersion、SourceAsset、multipart 状态与 Job 保留；Redis 故障时重试相同完成请求会从 PostgreSQL 重放 Envelope 并补投，不新建 Job |

`postgres_shadow_write` 开启时，SQLite 仍是旧 Bank 和 Question 的唯一主事实源。镜像成功时旧写接口附带 `shadow_sync.state=synced`；PostgreSQL 权限、连接或事务失败时，SQLite 写仍返回成功并附带 `shadow_sync.state=pending_reconciliation`。调用方不得因此重放已经成功的 SQLite 创建；发布方必须用新的不可变 Online Backup 运行 reconciliation，并在任何 `missing` / `drifted` 存在时阻断读切换。
