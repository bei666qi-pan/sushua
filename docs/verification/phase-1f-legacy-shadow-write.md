# Phase 1f：旧 Bank PostgreSQL shadow write 验证

验证日期：2026-09-01

## 本增量边界

- SQLite 继续作为旧 Bank、Question 和旧 API 的主事实源。
- `FEATURE_POSTGRES_SHADOW_WRITE` 默认关闭；关闭时不初始化 PostgreSQL，也不改变旧响应。
- 开启后，仅在 SQLite create/update/delete 成功后镜像 Learner、Workspace、唯一 owner 和 legacy mapping。
- PostgreSQL 镜像失败不回滚或伪造 SQLite 结果；响应明确标记 `pending_reconciliation`。
- 本增量未切换任何读路径，未迁移 QuestionVersion，未在生产开启 Flag，未同步 Gitee 或部署 Coolify。

## RED→GREEN 证据

| 契约 | RED 反向变异 | GREEN 结果 |
|---|---|---|
| Flag 默认关闭 | 临时移除 shadow service 的 Flag 早返回 | 测试捕获响应意外出现 `shadow_sync`；恢复守卫后通过 |
| 已认领 Learner 不被删除 | 临时移除 SQL 的 `user_id IS NULL` 回收条件 | 测试捕获绑定用户的 Learner 被误删；恢复条件后通过 |
| 在线写入与快照使用同一 checksum | 临时把新 mapping checksum 写成固定错误值 | Online Backup reconciliation 报告 `drifted`；恢复 canonical checksum 后，已同步 Bank 为 `matched`、未授权写入为 `missing` |

所有反向变异均已恢复，不存在于最终差异。

## 完整本地门禁

执行：

```bash
TEST_DATABASE_URL=<isolated-postgres> npm run ci:verify
```

结果：退出码 0。

- 单元测试：通过；包含 Flag 关闭时真实旧 `POST /api/banks`。
- Golden Corpus manifest：通过；仍为空跑骨架，不含真实用户资料。
- PostgreSQL 集成测试：通过；包含 shadow create/replay/update/delete、owner hash 拒绝、账号 Learner 保留、旧 API 失败降级和 Online Backup reconciliation。
- TypeScript：`tsc --noEmit` 通过。
- ESLint：0 warning / 0 error。
- Next.js 15.5.24 production build：通过，路由表完整生成。
- 生产依赖审计：`found 0 vulnerabilities`。

## 安全与回滚检查

- 原始 owner key 仅由旧 API 返回给创建者；shadow 路径只处理 SHA-256 hash，日志只包含固定事件码、operation 和 slug。
- 两个 SECURITY DEFINER 函数均撤销 `PUBLIC` 权限；测试角色为 `NOBYPASSRLS`，必须显式获得 `EXECUTE`。
- PostgreSQL 函数权限缺失时，SQLite 写成功且返回 `pending_reconciliation`，不会诱导客户端用 5xx 重复创建。
- 删除 placeholder Learner 前同时检查用户绑定、Guest Session、成员关系和其他 Workspace 引用。
- 回滚只关闭 `FEATURE_POSTGRES_SHADOW_WRITE`；已镜像数据保留用于只读对账。

## 尚未验证 / 禁止外推

- 未对生产 SQLite 执行 snapshot、backfill、shadow write 或 reconciliation。
- 未验证生产数据库角色授权、真实流量或多副本并发。
- 未切旧 API 的 PostgreSQL 读路径；题目内容仍只有 SQLite。
- 未运行 Gitee 镜像、Coolify 部署或公开端点验收。
- Phase 2–8 的对象存储、队列、Document Worker、OCR、Document IR、grounded AI、学习状态、FSRS、分析和 Artifact 均未开始。
