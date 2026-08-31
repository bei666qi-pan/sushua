# Database migration conventions

- 所有数据库变更使用按序、只前进的 SQL migration；禁止修改已经进入共享环境的 migration。
- Schema owner、Web、Worker 使用不同角色；Web 与 Worker 不得拥有 `BYPASSRLS`。
- 租户表必须有 `workspace_id`，并优先使用 `(workspace_id, parent_id)` 复合外键阻止跨租户引用。
- migration 在单次 release job 中执行，不由每个 Web 副本启动时并发执行。
- destructive migration 必须先完成兼容读写、备份恢复演练和回滚版本验证。
- 每次 migration 记录 Git SHA、执行时间、行数校验和、操作者与结果。

Phase 0 不创建或修改生产 Schema。

## Runtime grants

Migration owner 应在 Schema 更新后向 Web 角色授予表级最小权限，并单独授予以下安全边界函数；`<web_role>` 必须替换为部署环境实际的、无 `BYPASSRLS` 角色：

```sql
GRANT USAGE ON SCHEMA public TO <web_role>;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO <web_role>;
GRANT EXECUTE ON FUNCTION claim_guest_learner(text) TO <web_role>;
GRANT EXECUTE ON FUNCTION resolve_authenticated_learner(uuid) TO <web_role>;
GRANT EXECUTE ON FUNCTION claim_legacy_workspace(text) TO <web_role>;
GRANT EXECUTE ON FUNCTION claim_legacy_workspace_by_slug(text, text) TO <web_role>;
GRANT EXECUTE ON FUNCTION shadow_sync_legacy_workspace(text, text, text, text, text, text, timestamptz, uuid, uuid) TO <web_role>;
GRANT EXECUTE ON FUNCTION shadow_delete_legacy_workspace(text, text) TO <web_role>;
GRANT EXECUTE ON FUNCTION submit_job_v1(uuid, uuid, text, uuid, text, text, integer, jsonb, integer, uuid, uuid, timestamptz) TO <web_role>;
GRANT EXECUTE ON FUNCTION request_job_cancel(uuid, text) TO <web_role>;
GRANT EXECUTE ON FUNCTION complete_source_upload_v1(uuid, uuid, uuid, text, bigint, text, text, text, text, text, uuid, uuid, timestamptz) TO <web_role>;
```

认领函数从事务级 `app.user_id` / `app.learner_id` 读取服务端身份，并验证 Better Auth 用户、Guest token hash 或 legacy owner hash。shadow write 函数只接收旧 SQLite 已提交记录派生出的字段、owner hash 与 checksum，不接收原始 owner key。上传完成函数复核 Learner、Workspace、编辑权限、对象元数据和幂等请求，并在同一事务中推进三层文档状态与创建 `file.scan` Job；这些函数都不能授权给 `PUBLIC`。集成测试使用 `NOBYPASSRLS` Web 角色验证显式授权、未授权降级和跨表原子性。

Worker 角色只获得后台任务所需函数，不继承 Web 角色权限。Phase 1 游客保留清理需要：

```sql
GRANT USAGE ON SCHEMA public TO <worker_role>;
GRANT EXECUTE ON FUNCTION purge_expired_guest_learners(timestamptz, integer) TO <worker_role>;
GRANT EXECUTE ON FUNCTION transition_job_v1(uuid, text, jsonb, jsonb, text, timestamptz, timestamptz) TO <worker_role>;
```

这些后台函数保持 `PUBLIC` 权限撤销；Worker 无需获得租户表或 `jobs` 的直接 `UPDATE` / `DELETE` 权限。Web 读取 `jobs` 时仍通过强制 RLS，并需要已有的 `workspace_members` 读权限供策略判断成员身份。
