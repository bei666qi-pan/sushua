# Phase 1B local verification

- 日期：2026-08-31
- 基线：GitHub main `74c69c470bdf50a6705021245157527eda26c971`
- 数据库：真实 pgvector 0.8.6 / PostgreSQL 17 测试容器，无 `BYPASSRLS` Web 角色

## Verified causal chain

1. 首次游客 bootstrap 创建 UUIDv7 Learner；浏览器持有随机证明，数据库只保存 SHA-256。
2. 同一 Cookie 刷新后复用 Learner，并从最后活动时间滚动 30 天；篡改或数据库过期会创建新身份。
3. Workspace 创建强制 `Idempotency-Key`；相同键与正文返回原资源，不同正文返回 409，数据库只有一行和一个 owner。
4. 未登录认领返回 401；错误 Workspace UUID 返回 404 且 Learner 未变化。
5. 登录认领保持原 learner_id；已有账号 Learner 时返回 409 合并报告，不静默迁移。
6. 浏览器桌面与 390×844 移动端完成创建、刷新、登录回流与认领入口验证，无横向溢出。
7. Feature Flag 关闭时页面/API 在数据库和密钥初始化前返回 404。

## Current boundary

本增量未验证真实 SMTP 投递，未做 SQLite shadow write、legacy Bank backfill、对象存储、上传或 OCR。Gitee、Coolify 和公开生产环境均未改变。
