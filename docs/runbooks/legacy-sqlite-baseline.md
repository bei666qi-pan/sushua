# Legacy SQLite baseline and rollback runbook

Phase 1 开始前，对生产 SQLite 执行以下只读基线记录：

1. 停止会改变 Bank/Question 的管理操作，保留普通读取。
2. 使用 SQLite Online Backup API 创建一致性快照，不直接复制活动 WAL 文件。
3. 记录数据库文件大小、SHA256、四张旧表行数和每个 Bank 的稳定 checksum。
4. 将快照写入受控备份位置并进行一次独立恢复验证。
5. dry run 导入 PostgreSQL 临时 Schema，逐项比对 slug、题目顺序、答案、owner hash 和缓存元数据。
6. 任何不一致都停止切换；不得通过删除差异数据制造“通过”。

回滚只切换 Feature Flag 和读路径：SQLite 快照保持只读，已写入 PostgreSQL 的数据保留用于对账，不在故障处理中删除。

## 本地/发布任务命令

在冻结旧 Bank 管理写入后，由 migration owner 在能读取 SQLite 持久卷、但不对公网暴露的单次任务中执行：

```bash
npm run legacy:snapshot -- \
  --source /受控只读挂载/sushua.db \
  --snapshot /受控备份目录/sushua-20260901T000000Z.db
```

命令通过 SQLite Online Backup API 生成一致性快照，并向标准输出写 JSON 报告：快照绝对路径、文件大小、SHA256、四表行数及逐 Bank checksum。报告不包含题目正文。发布系统必须将 JSON 输出作为受控构建/迁移产物归档。

- 目标快照已存在时命令失败，禁止覆盖旧证据。
- 目标路径不能与活动数据库相同。
- 快照完成后，用新进程以只读方式打开备份并重复 SHA256/行数检查。
- 任何 Bank checksum 不一致都停止 backfill 和读切换；不得修改快照制造一致。

## Workspace mapping dry-run 与提交

先把 PostgreSQL Schema 恢复到一次性 dry-run 数据库，并使用专用连接执行。脚本即使成功也会回滚全部写入：

```bash
LEGACY_DRY_RUN_DATABASE_URL=postgresql://... \
npm run legacy:backfill -- --snapshot /受控备份目录/sushua-20260901T000000Z.db
```

报告中每个 Bank 必须为 `ready` 或同 checksum 的 `replayed`；`questions_pending` 是尚未进入 QuestionVersion 的题目数，Phase 1 禁止把它报告为已迁移内容。

只有快照 SHA256、四表行数、逐 Bank checksum、dry-run 和恢复演练全部通过后，才在 release job 中显式增加 `--commit`：

```bash
DATABASE_DIRECT_URL=postgresql://... \
npm run legacy:backfill -- \
  --snapshot /受控备份目录/sushua-20260901T000000Z.db \
  --commit
```

- 未写 `--commit` 时脚本拒绝使用 `DATABASE_DIRECT_URL`，降低误写生产的风险。
- 正式提交在一个事务中创建 placeholder Learner、Workspace、唯一 owner 和 `legacy_bank_mappings`。
- 旧 `unlisted` 映射为新 `link`；旧 slug、owner hash、创建时间和完整内容 checksum 保留。
- 任一 checksum 漂移、slug 占用或非法字段使整批回滚，不能跳过冲突继续发布。
- 题目与 AI cache 仍由 SQLite 读取；必须等 QuestionVersion/tenant cache Schema 和 reconciliation 完成后再切内容读路径。

## 只读 reconciliation

backfill 后使用同一个不可变快照重新对账：

```bash
DATABASE_DIRECT_URL=postgresql://... \
npm run legacy:reconcile -- \
  --snapshot /受控备份目录/sushua-20260901T000000Z.db
```

报告逐 Bank 比较 mapping 身份、checksum、owner hash、Workspace 标题/可见性和唯一 owner 不变量。全部一致时退出 0；任一 `missing` 或 `drifted` 退出 2，必须阻断读切换。该命令只读，不会自动补写或修正 PostgreSQL；差异必须回到快照、backfill 或应用写路径查根因。

## 旧 Bank shadow write 灰度

完成初始 backfill 和零差异 reconciliation 后，先执行 `0007_legacy_shadow_write.sql`，再由 migration owner 仅向实际 Web 角色授予两个 shadow 函数的 `EXECUTE`。确认 Web 角色无 `BYPASSRLS`、`PUBLIC` 无函数权限后，才可在受控环境开启：

```bash
FEATURE_POSTGRES_SHADOW_WRITE=true
```

开启后的写入顺序固定为：

1. 旧 API 完成原有 owner key 校验和 SQLite create/update/delete。
2. 服务端从已提交的 SQLite Bank 读取完整 canonical 内容；原始 owner key 不进入 PostgreSQL、URL、日志或响应。
3. PostgreSQL 在一个 SECURITY DEFINER 函数事务中创建或更新 placeholder Learner、Workspace、唯一 owner 和 mapping；相同 checksum 重放返回 `replayed`。
4. 镜像成功时响应包含 `shadow_sync.state=synced`；镜像失败时 SQLite 主写不回滚，响应包含 `pending_reconciliation`，服务端只记录固定事件码、operation 和 slug。

`pending_reconciliation` 不是失败的 SQLite 创建，也不是可以让客户端安全重试的 5xx。运营侧必须保存该响应/事件，创建新的 SQLite Online Backup，并运行只读 reconciliation。任何 `missing` 或 `drifted` 都阻断 PostgreSQL 读切换；对账工具不会自动修复差异。

每轮灰度至少验证：

- Flag 关闭时旧响应无 `shadow_sync`，且缺少 `DATABASE_URL` 也能正常写 SQLite。
- create、PATCH 和 DELETE 的 SQLite 结果与 PostgreSQL mapping/Workspace 一致。
- PostgreSQL 函数权限被撤销时，SQLite 仍成功且响应明确为 `pending_reconciliation`。
- 新 Online Backup 中已同步 Bank 为 `matched`，pending Bank 为 `missing`；对账退出码可阻断后续读切换。
- 已绑定 Better Auth 用户的 Learner 不会因删除旧 Bank 而被回收。

回滚只关闭 `FEATURE_POSTGRES_SHADOW_WRITE`。关闭后旧 API 立即恢复纯 SQLite 行为，已写 PostgreSQL 数据保留供后续对账；禁止在回滚时删除它们。此阶段没有 QuestionVersion，题目内容和全部旧读路径仍使用 SQLite。
