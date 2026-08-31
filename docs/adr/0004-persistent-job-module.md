# ADR 0004: PostgreSQL 是 Job 事实源，队列只做投递

- 状态：Accepted
- 日期：2026-09-01

## 背景

Phase 2 将引入文件扫描、文档解析和清理等异步任务。若 Web、Worker 和未来 Redis/BullMQ 分别维护状态与重试规则，断线、Worker 重启和重复提交会产生多个互相冲突的真相；把完整文件或原文放进 Redis 也扩大私密数据面。

## 决定

- `@sushua/job-contracts` 提供严格、版本化的 `JobEnvelope v1` 解析 seam。当前只允许 `file.scan`、`document.parse` 和 `document.cleanup`；未知版本、未知类型、额外字段、非 UUIDv7 ID 和非法 budget/checkpoint 全部失败关闭。
- Job Module 的外部 interface 只有 `submit`、`read`、`apply` 和 `requestCancel`。幂等 hash、UUIDv7、状态转换、attempt、checkpoint、RLS 和数据库函数都隐藏在 module 内。
- PostgreSQL `jobs` 是唯一事实源。Redis/BullMQ 后续 Adapter 只携带 Job ID 与最小 Envelope，不保存文件或原文；Worker 必须从持久 Job 重新读取 `workspace_id`。
- Web 只能通过 SECURITY DEFINER 函数提交和请求取消，并通过强制 RLS 读取。owner/editor 可提交或取消，viewer 只能读取。
- Worker 只能调用 transition 函数；函数按 Job ID 锁行并从已持久化记录取得租户，不信任队列 payload 中的 Workspace。
- 状态机固定为 `queued → running → succeeded | partially_succeeded | failed | dead_lettered`，以及 `queued/running → cancel_requested → cancelled`。临时错误可在未耗尽 `max_attempts` 时由 `running → queued`。

## 结果

- 相同 Workspace/type/idempotency key 与相同正文重放同一个 Job；不同正文明确冲突。
- Worker kill/restart、QueueEvents 丢失或 Redis 恢复后，可以从 PostgreSQL state/checkpoint 继续。
- 现阶段没有 Redis Adapter、Job Stream、Document 表或后台进程；本 ADR 不能被解释为异步上传已可用。
- 新 Job 类型必须同时更新协议、数据库 enum、测试和消费者，不能让未知字符串静默进入队列。
