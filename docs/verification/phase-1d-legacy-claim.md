# Phase 1D legacy owner claim verification

- 日期：2026-09-01
- 基线：GitHub main `01561e49c8e6d230df950c2418c1ebb4ab391f0e`

## Verified causal chain

1. 本地 owner key 在 Node 层先计算 SHA-256，PostgreSQL 只接收 hash；响应和 URL 都不回显凭证。
2. `claim_legacy_workspace_by_slug(text, text)` 从事务级 Learner/User 上下文验证 Better Auth 身份，再按 legacy slug 锁定 mapping，不需要先向客户端暴露私有 Workspace UUID。
3. 正确 key 原子转移 `workspaces.created_by_learner_id` 和唯一 owner member，并写入 `claimed_by_learner_id/claimed_at`。
4. 同一账号重放返回 `already_claimed`；错 key 返回 401 且 mapping 不变；另一账号使用已认领的旧 key 返回 409，不能夺权。
5. Feature Flag 路由反向变异测试证明：若在 Flag 关闭时初始化 Auth/DB，测试会因缺少配置失败；恢复条件初始化后返回 404。
6. 应用内浏览器以真实上传样例生成 owner key 并打开旧题库：桌面端“管理”中可见认领入口；`?claim=1` 回流会显式展开“完成认领”；390×844 视口无水平溢出，主按钮高 44px。
7. Mode 1 设计审查只检查用户路径、现有 token、可访问性、响应式和可信错误；无阻断或主要问题，未改变现有绿色纸张视觉方向。

## Full local gate

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/sushua_test npm run ci:verify
```

2026-09-01 本地完整运行退出码为 0：Unit、Golden 和 PostgreSQL/RLS 集成测试全部通过，`tsc --noEmit`、ESLint 和 Next.js 15.5.24 生产构建通过，`npm audit --omit=dev --audit-level=high` 报告 0 漏洞。

## Current boundary

- PostgreSQL 还没有 QuestionVersion；认领只转移 Workspace 所有权，题目内容仍以 SQLite 为事实源。
- 未执行生产 SQLite snapshot/backfill，未实现 shadow write、reconciliation 或读切换。
- 未验证真实 SMTP/OTP 投递；浏览器流程未发送本机 owner key，成功/冲突分支由真实 PostgreSQL 集成测试验证。
- Gitee、Coolify 和公开生产环境均未改变。
