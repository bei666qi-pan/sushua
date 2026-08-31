# Phase 1A local verification

- 日期：2026-08-31
- 基线：GitHub main `2bf7fef69223867af76e1691d37fbc77725ce983`
- 数据库：pgvector 0.8.6 / PostgreSQL 17，digest `sha256:cf134a767f…0f8e6f`

## Verified causal chain

1. 在真实 PostgreSQL 中应用 `0001_workspace_identity.sql`，并重复执行 migration runner。
2. migration ledger 只有一条记录，证明幂等重跑未重复执行。
3. 使用无 `BYPASSRLS` 的 `sushua_web_test` 角色创建两个 Learner、Guest Session 和私有 Workspace。
4. A/B 查询只返回各自私有 Workspace；A 猜测 B 的 UUID 得到 0 行。
5. A 尝试向 B 写成员关系被数据库拒绝。
6. A 切换公开后 B 可读取内容，但 B 没有获得成员关系。
7. 第二个 owner 写入被数据库唯一约束拒绝。
8. Learner、Guest Session、Workspace、Member、Share、Legacy Mapping 六张租户表均为 ENABLE + FORCE RLS。

## Current boundary

本增量尚未接入 Better Auth OTP、登录认领、旧 SQLite shadow write 或前端资料库。依赖已固定，但认证功能不能因 Schema 存在而声称可用。
