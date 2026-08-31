# Legacy SQLite baseline and rollback runbook

Phase 1 开始前，对生产 SQLite 执行以下只读基线记录：

1. 停止会改变 Bank/Question 的管理操作，保留普通读取。
2. 使用 SQLite Online Backup API 创建一致性快照，不直接复制活动 WAL 文件。
3. 记录数据库文件大小、SHA256、四张旧表行数和每个 Bank 的稳定 checksum。
4. 将快照写入受控备份位置并进行一次独立恢复验证。
5. dry run 导入 PostgreSQL 临时 Schema，逐项比对 slug、题目顺序、答案、owner hash 和缓存元数据。
6. 任何不一致都停止切换；不得通过删除差异数据制造“通过”。

回滚只切换 Feature Flag 和读路径：SQLite 快照保持只读，已写入 PostgreSQL 的数据保留用于对账，不在故障处理中删除。
