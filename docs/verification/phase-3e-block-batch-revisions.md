# Phase 3e：批量 Block 修订 API

## 范围

新增 `PATCH /api/v1/blocks/batch`，受既有 `source_review` Feature Flag
保护，默认关闭。它只创建 append-only `document_revisions` 和
`document_revision_blocks` 记录；不物化新的 DocumentVersion、不触发重解析、
不提供撤销 UI。

## 请求

所有请求必须带 `Idempotency-Key`。正文是严格白名单：

```json
{
  "workspace_id": "UUIDv7",
  "document_id": "UUIDv7",
  "base_document_version_id": "UUIDv7",
  "base_revision_number": 0,
  "operations": [
    {
      "source_block_id": "UUIDv7",
      "operation": "edit",
      "patch": { "text": "人工修正后的正文" }
    }
  ]
}
```

`operation` 只接受 `edit`、`delete`、`split`、`merge`；同一个 Block
不能在单一 batch 内出现两次。响应使用标准 v1 envelope，首次创建返回 `201`，
同键同正文重放返回 `200` 与 `meta.idempotent_replay=true`。

## 并发与隔离

每个 Workspace/Document 组合在事务内取得 PostgreSQL advisory lock，随后比较
`base_revision_number` 与持久化的最新修订号。版本不一致返回
`409 document_revision_conflict`，不写入任何修订。

请求哈希由 Idempotency-Key 与 `(workspace, document, base version,
revision number, operations)` 的规范化 JSON 共同计算；相同 key 搭配不同正文返回
`409 idempotency_conflict`。数据库同时以 `(workspace_id, document_id,
idempotency_key)` 唯一约束兜底。

RLS 只允许 owner/editor 写入，viewer 返回 `403 editor_permission_required`；
其他 Workspace 因基版本不可见返回防枚举 `404`。修订表维持无 UPDATE/DELETE
policy，确保记录不可变。

## 已验证

在隔离 PostgreSQL、Redis、ClamAV 下：

```sh
TEST_DATABASE_URL=<isolated-postgres> \
TEST_REDIS_URL=<isolated-redis> \
TEST_CLAMAV_HOST=<isolated-clamav-host> \
TEST_CLAMAV_PORT=<isolated-clamav-port> \
npm run test
npm run typecheck
npm run lint
npm run build
npm run audit
```

`test/document-revision-api.test.ts` 以真实 PostgreSQL 和无 `BYPASSRLS`
Web 角色覆盖 owner 创建、重放、过期并发、viewer 拒绝和跨 Workspace 防枚举。
`test/document-revision-api-disabled.test.ts` 确认 Flag 关闭时路由不会初始化认证或数据库。
