# Phase 1C legacy backfill verification

- 日期：2026-09-01
- 基线：GitHub main `3ef2028410d5fe5d31589ea81db75f1ac8a450b8`

## Verified causal chain

1. 从 Online Backup 快照读取两个 Bank、三道题和 owner hash，重新计算逐 Bank checksum。
2. PostgreSQL dry-run 真实执行 placeholder Learner、Workspace、owner 和 mapping 写入后回滚，四表均保持 0 行。
3. 显式 commit 后四类资源各 2 行；旧 `unlisted` 被确定性映射为 `link`。
4. 相同快照重跑全部返回 `replayed`，数据库计数不变。
5. 修改一条旧题答案后新快照 checksum 变化，整批返回 conflict 并回滚，旧 mapping 不被覆盖。
6. 报告明确三道题均为 `questions_pending`；Phase 1C 没有声称题目内容已迁移。

## Current boundary

未执行生产快照或 backfill；未实现 shadow write、legacy owner 认领、QuestionVersion 内容迁移或读切换。Gitee、Coolify 和公开生产环境未改变。
