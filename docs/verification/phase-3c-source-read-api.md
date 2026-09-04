# Phase 3c: Source review read API verification

Date: 2026-09-04

## Scope

This increment adds the read-only seam for source review:

- `GET /api/v1/document-versions/{id}/pages`
- `GET /api/v1/pages/{id}/blocks`

Both routes remain behind the existing, default-off `source_review` feature flag.
They do not create short-lived object URLs, render a source viewer, edit Blocks,
or generate AI content.

## Interface and invariants

- `DocumentSourceModule` is the only caller-facing interface. It accepts an actor,
  a DocumentVersion or Page id, and bounded cursor/filter input; it owns RLS-backed
  visibility checks, stable ordering and cursor encoding.
- Pages use `(page_number, id)` and Blocks use `(reading_order, id)` ordering. A
  cursor is bound to the resource it was issued for, so one Page/Version cursor
  cannot be reused against another resource.
- Block type and minimum-confidence filters are parsed before identity resolution
  and executed in PostgreSQL. Invalid query input fails closed.
- An inaccessible or non-existent DocumentVersion/Page returns the same 404 error
  shape, preventing resource enumeration. No source text is logged.
- An ordinary Workspace viewer may read source metadata and Blocks; a learner in a
  different Workspace cannot read either by guessing IDs.

## Fresh focused evidence

Using a local isolated PostgreSQL instance at `127.0.0.1:55442`:

```text
Document source v1 HTTP API
  ✓ Page 以稳定游标分页，游客读取会续期身份 Cookie
  ✓ A/B 租户猜测 DocumentVersion 只能获得防枚举 404
  ✓ Block 按阅读顺序游标分页，并在数据库侧执行类型与置信度过滤
  ✓ A/B 租户猜测 Page 或 Block 不能越过 RLS 读取来源文字
  ✓ 无效过滤条件在读取前被拒绝
  ✓ 空置信度不被宽松转换成零值过滤
```

The pre-existing unit suite, TypeScript typecheck, ESLint and Next.js production
build also passed in this worktree. The existing FastAPI document service test
passed after synchronizing its locked Python environment.

## Explicit non-claims

This is not a production deployment claim. The flag remains off; no viewer UI,
source-object URL endpoint, or Block-edit API has been added. GitHub CI, Gitee
mirroring, Coolify deployment, and public endpoint checks are required before
calling this increment released.
