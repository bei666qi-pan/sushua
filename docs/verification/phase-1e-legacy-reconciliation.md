# Phase 1E legacy reconciliation verification

- 日期：2026-09-01
- 基线：GitHub main `1c671e1f5ea4deec7e97d5ba38f4128bcba026cd`

## Verified causal chain

1. 同一 SQLite Online Backup 快照经 backfill 后，checksum、title、visibility、owner hash 和唯一 owner 均一致，报告 `matched=1`。
2. 人为改动 PostgreSQL Workspace title 和 mapping checksum 后，报告同时列出 `title_changed` 与 `checksum_changed`，不覆盖差异。
3. 对账后再查 PostgreSQL，人为漂移值仍保留，证明 reconciliation 只读。
4. 删除 Workspace 导致 mapping 级联消失时，报告 `missing/mapping_missing`，不伪造通过。
5. 独立 CLI 在全部一致时输出 JSON 并退出 0；反向变异验证了 missing/drifted 分支必须退出 2，可作为后续读切换门禁。

## Current boundary

- 这一增量只建立对账尺度，还没有把旧 Bank 创建/更新/删除接入 Postgres shadow write。
- PostgreSQL 仍无 QuestionVersion，题目内容仍以 SQLite 为事实源。
- 未执行生产 snapshot、backfill 或 reconciliation；未切换读写，未改 Gitee、Coolify 或公开生产。
