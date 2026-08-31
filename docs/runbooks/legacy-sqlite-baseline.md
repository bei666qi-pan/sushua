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
