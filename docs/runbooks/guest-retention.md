# 游客资料 30 天保留与清理 Runbook

未登录 Learner 的 `guest_sessions.expires_at` 每次通过有效 Guest Cookie 活动时滚动到 30 天后。清理只处理 cutoff 之前同时满足以下条件的身份：

- Guest Session 已过期；
- `claimed_at` 与 `claimed_by_user_id` 均为空；
- Learner 未绑定 Better Auth 用户；
- Learner 没有成为其他创建者 Workspace 的 owner。

清理在一个数据库事务中按 `expires_at, session_id` 排序并用 `FOR UPDATE SKIP LOCKED` 分批锁定。先删除该 Learner 创建的 Workspace，再删除 Learner；Workspace 的分享、legacy mapping 和成员关系通过外键级联清理。删除 Learner 同时级联 Guest Session 和其在其他 Workspace 中的 viewer/editor 成员关系。

## 运行前门禁

1. PostgreSQL migration 已执行到 `0008_guest_retention_cleanup.sql`。
2. migration owner 只向实际 Worker 角色授予 `purge_expired_guest_learners` 的 `EXECUTE`；该角色必须为 `NOBYPASSRLS`，且 `PUBLIC` 无权限。
3. 已完成 PostgreSQL 与对象存储联合备份；Phase 1 尚无对象资料，进入 Phase 2 后必须把对象删除纳入 deletion manifest，不能只运行本命令。
4. 确认当前用户界面仍明确告知“从最后活动时间起保留 30 天”。
5. 首次生产运行使用小批量并在低峰执行；禁止把未来时间作为 cutoff。

## 执行

命令默认拒绝删除，必须显式传入 `--commit`：

```bash
DATABASE_URL=postgresql://<worker-role>@<postgres>/<database> \
npm run guest:cleanup -- \
  --before 2026-09-01T00:00:00Z \
  --limit 100 \
  --commit
```

- `--before` 省略时取任务启动时刻；数据库拒绝未来 cutoff。
- `--limit` 默认 100，范围 1–1000。
- 输出仅包含 cutoff、limit、清理的 Session/Learner/Workspace 计数，不包含用户、token、Workspace 标题或资料内容。
- 重复执行幂等；持续分批运行，直到三个清理计数都为 0。
- 未传 `--commit` 时退出 1 且不连接数据库执行删除，防止手工误触。

## 阻断与调查

若过期 Learner 异常地成为其他创建者 Workspace 的 owner，函数会跳过该 Learner，避免产生无 owner Workspace。此类记录不得通过手工删除绕过，应先检查 owner/creator 不变量、认领历史和审计记录，再决定转移所有权或删除 Workspace。

函数在所选 Session 数、实际删除 Learner 数不一致时回滚整个批次并返回 `guest_cleanup_concurrent_state_changed`。发生该错误时检查是否与认领任务并发；不要删除用户绑定或清空认领字段制造通过。

## 当前边界

Phase 1 的命令只覆盖 PostgreSQL 中的 Learner、Guest Session、Workspace、分享和 legacy mapping。它不会删除 SQLite 旧 Bank、未来对象存储文件、AI cache、Attempt 或 ReviewLog。进入相应 Phase 后必须由 `deletion.purge` 和可审计 manifest 接管完整清除；在此之前不得把本命令描述为“彻底删除全部个人数据”。
