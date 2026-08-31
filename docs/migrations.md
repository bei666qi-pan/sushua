# Database migration conventions

- 所有数据库变更使用按序、只前进的 SQL migration；禁止修改已经进入共享环境的 migration。
- Schema owner、Web、Worker 使用不同角色；Web 与 Worker 不得拥有 `BYPASSRLS`。
- 租户表必须有 `workspace_id`，并优先使用 `(workspace_id, parent_id)` 复合外键阻止跨租户引用。
- migration 在单次 release job 中执行，不由每个 Web 副本启动时并发执行。
- destructive migration 必须先完成兼容读写、备份恢复演练和回滚版本验证。
- 每次 migration 记录 Git SHA、执行时间、行数校验和、操作者与结果。

Phase 0 不创建或修改生产 Schema。
