# Phase 1g：游客 30 天保留清理验证

验证日期：2026-09-01

## 本增量边界

- 增加 PostgreSQL `0008_guest_retention_cleanup.sql`，只处理已过期、未认领、未绑定用户的 Guest Learner。
- 清理按固定顺序、限制批量、`FOR UPDATE SKIP LOCKED` 执行；先删自有 Workspace，再删 Learner。
- Worker 只获得 SECURITY DEFINER 函数的显式 `EXECUTE`，不需要租户表直接 `DELETE` 权限。
- 增加 `npm run guest:cleanup` 运维入口；未传 `--commit` 时退出 1 且不删除。
- 本增量未在生产运行或调度清理，未引入 BullMQ；Phase 2 前仍是受控手工/计划任务入口。

## RED→GREEN 与反向变异

| 契约 | RED / 反向变异 | GREEN 结果 |
|---|---|---|
| 清理模块与数据库边界 | 测试先在模块不存在时失败 | 模块、migration 和真实 PostgreSQL 事务实现后通过 |
| CLI 显式提交 | 测试先在 CLI 不存在时失败 | 无 `--commit` 拒绝且数据不变；显式提交后只输出计数 |
| 不产生无 owner Workspace | 临时移除“其他创建者 Workspace owner”排除条件 | 测试捕获异常 Learner 被多清理；恢复条件后通过 |
| 禁止未来 cutoff | 临时移除 `p_before > now()` 检查 | 测试捕获未来 cutoff 未拒绝；恢复检查后通过 |

所有反向变异均已恢复，不存在于最终差异。

## 真实 PostgreSQL 因果链

- 未授权 `NOBYPASSRLS` Worker 调用函数得到 permission denied。
- 最早过期 Learner 被选中后，其自有 Workspace、Workspace Share、legacy mapping、Guest Session 和跨 Workspace viewer 关系均实际消失。
- 活跃 Guest、已绑定 Better Auth 用户、已认领 Session 和异常跨所有权 Learner 均实际保留。
- limit=1 只处理最早一条；下一批继续处理；第三次重放计数为 0。
- 未来 cutoff 和 limit=0 在任何删除前失败关闭。

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

- 未在生产授予 Worker 权限、运行 cleanup 或建立定时调度。
- 未删除原始 SQLite Bank；旧 Bank 仍由 legacy 路径管理。
- Phase 2 尚无对象存储，因此本命令不包含对象文件删除；未来必须由 deletion manifest 扩展。
- AI cache、Attempt、ReviewLog、备份生命周期和对象版本清理尚未实现，不能把本增量称为“彻底删除全部个人数据”。
- Gitee、Coolify 和公开生产端点未改变。
