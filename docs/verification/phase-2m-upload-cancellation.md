# Phase 2m：上传取消与 multipart 清理

日期：2026-09-02

## 边界

- 新增 `DELETE /api/v1/uploads/{asset_id}`，仅在 `async_ingestion` 开启时装配身份、PostgreSQL 和对象存储。
- 请求必须携带 `Idempotency-Key`；路径 ID 在初始化任何依赖前校验。
- PostgreSQL `abort_source_upload_v1` 以 SourceAsset 行锁裁决完成/取消竞态；只有 owner/editor 可取消，viewer 和其他租户统一得到 404。
- 取消先将 SourceAsset 原子转为 `aborted`，将 DocumentVersion 标记 `upload_cancelled`，并立即撤销 Document 在线访问；随后中止 multipart。
- 若对象存储短暂失败，数据库仍保持已撤销状态，同一取消请求可重放继续清理；已不存在的 multipart 按幂等成功处理。

## 证据

- RED：路由不存在时默认关闭测试失败；取消 handler 不存在时真实 PostgreSQL 集成测试失败。
- GREEN：默认关闭路由不初始化依赖；owner 取消、幂等重放、multipart 清理和跨租户拒绝均通过真实 PostgreSQL 集成测试。
- 本增量不开启生产 Feature Flag，不改变旧 `/api/parse` 和 `/b/[slug]` 行为。
