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
| `guest_claim` | 邮箱 OTP、游客 bootstrap、Workspace 认领 | `/login`、`/api/auth/*`、认领 API 为 404；不初始化 Auth/Guest 服务 | 已有用户与游客记录保留 |
| `workspace_library` | `/workspaces`、`GET/POST /api/v1/workspaces` | 页面和 API 为 404；旧 `/b/[slug]` 不变 | 已有 Workspace 保留 |
