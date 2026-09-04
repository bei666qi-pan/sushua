# Phase 3b: Document IR indexing verification

Date: 2026-09-04

## Scope

This increment adds the Worker-side `DocumentIrIndexingModule` and the restricted
`index_document_ir_v1` PostgreSQL function. Public feature flags remain disabled.
It does not add source review UI, new upload formats, AI generation, or a public
Document IR endpoint.

## Invariants

- The module streams the IR object through the existing private object-reader seam,
  checks its SHA-256 against the Document Service result, and rejects malformed or
  oversized content before database writes.
- Schema, Workspace/Document/Version identity, source identity, parser/version,
  page count, block type, bounding box, source hash and tenant object-key checks
  all occur before persistence.
- The Worker has no direct `pages` or `blocks` write privilege. It receives only
  `EXECUTE` on a narrowly-scoped SECURITY DEFINER function, which derives the
  Workspace and DocumentVersion from the locked PostgreSQL job and expected attempt.
- The SQL function writes all Pages and Blocks atomically, stores immutable index
  evidence, treats the same IR hash as a replay, and rejects a different hash.
- A database trigger prevents every `DocumentVersion` transition to `ready` until
  the matching IR SHA has been indexed. The parse Handler indexes before calling
  `parse.succeed`; an index failure cannot publish a ready parse.

## Fresh focused evidence

Using a local PostgreSQL instance at `127.0.0.1:55442`:

```text
Document IR indexing module
  ✓ 未经索引的 IR 不能把 DocumentVersion 标为 ready
  ✓ 有效的两页 IR 经 SHA 验证后原子写入 Page/Block 和索引证据
  ✓ Worker 无表写权限，只能经受限索引函数写入
  ✓ 同一经验证 IR 重放不复制不可变 Page/Block
  ✓ Python Docling 的零值浮点 bbox source hash 可跨运行时验证
  ✓ SHA、租户身份和 bbox 任何一项异常均拒绝且不留下部分写入

Document parse handler indexing gate
  ✓ 索引失败阻止 parse.succeed，版本保持非 ready
  ✓ IR 已索引后的瞬态持久化异常仍保留原有重试策略
  ✓ 明确的临时索引故障保留安全码并进入重试，而非永久失败

```

The existing real PostgreSQL parse state-machine and Handler integration tests,
TypeScript typecheck and ESLint also passed after the change.

## Explicit non-claims

This is not production deployment evidence. No public flag has been enabled, no
GitHub PR has been opened, and no Gitee/Coolify/public-endpoint verification has
occurred for this increment.
