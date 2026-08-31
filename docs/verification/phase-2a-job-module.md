# Phase 2a：持久 Job Module 与 Envelope v1 验证

验证日期：2026-09-01

## 本增量边界

- 根仓库开始使用 npm workspaces，但现有 Next.js 根目录未移动。
- 新增 `@sushua/job-contracts`，严格解析 `JobEnvelope v1`；当前只允许 `file.scan`、`document.parse`、`document.cleanup`。
- PostgreSQL `jobs` 保存租户、幂等、预算、进度、checkpoint、attempt、取消和终态，是唯一事实源。
- Job Module 的 interface 为 `submit/read/apply/requestCancel`；Web 与 Worker 不直接拼状态机 SQL。
- 本增量没有 Redis/BullMQ Adapter、`apps/job-worker` 进程、Document 表、上传 API、Job Stream 或 UI，不能被解释为异步上传已可用。

## RED→GREEN 证据

| 契约 | RED | GREEN |
|---|---|---|
| Workspace 协议包 | `@sushua/job-contracts` 不存在，单元测试失败 | npm workspace 与严格 Envelope parser 实现后通过 |
| 持久 Job Module | module 不存在，PostgreSQL 集成测试失败 | migration、RLS、数据库函数和 module 实现后通过 |
| viewer 取消权限 | viewer 调用取消未被拒绝 | 数据库函数限制 owner/editor 后通过 |
| 乱序事件 | 17:59 progress 覆盖 18:00 状态，测试失败 | `stale_job_event` 数据库门禁后通过 |
| 绕过 module 的私密 progress | Worker 直接写入 `sourceText` 未被拒绝 | 数据库严格字段/类型/大小校验后通过 |

## 真实 PostgreSQL 因果链

- Web 未获函数 `EXECUTE` 时 submit 被拒绝；获权后创建 UUIDv7 Job 与 Envelope。
- 相同 Workspace/type/idempotency key 和相同 request hash 返回同一 Job；不同 resource 明确 `job_idempotency_conflict`。
- Learner A 可读自己的 Job；Learner B 猜测 Job ID 仍被 FORCE RLS 隔离。
- Worker 只提交 Job ID，数据库锁行并执行 `start → progress → retry → start → succeed`，attempt 与 checkpoint 持久更新。
- `maxAttempts=1` 时 retry 被拒绝，显式 `dead_letter` 后进入 `dead_lettered`，不伪造成功或继续重试。
- owner 取消请求幂等；跨租户与 viewer 拒绝；Worker 确认后进入 `cancelled`。
- Worker 直接绕过 module 传入额外 progress 字段仍被数据库拒绝。

## 完整本地门禁

执行：

```bash
TEST_DATABASE_URL=<isolated-postgres> npm run ci:verify
```

结果：退出码 0。

- 全部 unit / Golden / PostgreSQL integration tests：通过。
- TypeScript `tsc --noEmit`：通过。
- ESLint：0 warning / 0 error。
- Next.js 15.5.24 production build：通过。
- `npm audit --omit=dev --audit-level=high`：`found 0 vulnerabilities`。

## 禁止外推

- 未安装或运行 Redis/BullMQ，未证明投递、QueueEvents、Worker kill/restart 或 checkpoint 恢复。
- 未建立 Upload、Document、DocumentVersion、SourceAsset 或对象存储。
- 未提供 `/api/v1/jobs/{id}`、stream 或 cancel HTTP 路由。
- 未在生产执行 `0009_jobs.sql` 或授予 Web/Worker 函数权限。
- Gitee、Coolify 和公开生产端点未改变。
