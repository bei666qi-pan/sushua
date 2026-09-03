# Phase 3a: Document IR Page and Block schema verification

Date: 2026-09-04

## Scope

- Add immutable, Workspace-scoped `pages` and `blocks` relations for
  `sushua.document-ir.v1`.
- Preserve source dimensions, normalized `[x, y, width, height]` bounding boxes,
  source hashes, reading order and optional tenant-scoped rendered/image assets.
- Enforce Workspace-scoped DocumentVersion, Page and parent-Block references in
  PostgreSQL, and force membership RLS for both tables.
- Expose the two relations through the Drizzle schema.

This increment deliberately does not index Document Service IR objects yet, add
the source-review UI, or enable a public feature flag. A later Worker-side
indexer must validate and persist a completed IR object without replacing this
immutable version boundary.

## RED -> GREEN evidence

The initial Drizzle contract failed because `postgresSchema.pages` was absent.
The focused real-PostgreSQL test then exposed a separate test-environment
failure: the restricted reader role had `SELECT` on `pages`/`blocks`, but not on
`workspace_members`, which is the table evaluated by the Page RLS policy. This
is an authorization prerequisite, not a policy bypass. The test now grants only
the RLS dependency's read permission, then proves Learner A sees its Page while
Learner B sees zero Pages.

The real temporary PostgreSQL 16 instance also rejects zero Page dimensions,
out-of-range normalized bounding boxes, and a DocumentVersion from another
Workspace. The same test creates a Block with the valid Page/Version tuple so
the composite foreign-key path is exercised as part of the migration.

## Fresh local verification

- `TEST_DATABASE_URL=<isolated-postgres> npx --no-install tsx test/document-ir-schema.test.ts`
  passed after the RLS-role correction.
- `npm run test:unit`, `npm run typecheck`, `npm run lint`, and `npm run build`
  completed successfully.
- `npm run audit` found no HIGH or CRITICAL production dependency advisories;
  the pre-existing `@xmldom/xmldom` moderate advisory remains visible.
- `TEST_DATABASE_URL=<isolated-postgres> TEST_REDIS_URL=<isolated-redis>
  npx --no-install tsx test/job-worker-runtime.test.ts` passed, including
  PostgreSQL-authoritative tenant lookup, lease fencing, retries, cancellation
  and dead-letter behavior.

The complete local `npm run test:integration` reached and passed the Document
Service, Docling adapter, PostgreSQL, RLS, learner, Workspace and Job API
segments, then stopped because the machine had no `TEST_REDIS_URL`. A fresh,
loopback-only Redis supplied that missing prerequisite and the focused BullMQ
tests passed. The host has no running Docker daemon, so the real ClamAV segment
cannot be honestly claimed as locally verified. GitHub CI supplies isolated
PostgreSQL 17 + pgvector, Redis and ClamAV service containers and must be green
before merge.

## Release boundary

This is a persistence seam only. It does not claim that Page/Block indexing,
source navigation, OCR review or any public Document IR capability is live.
Merge and release still require the full GitHub CI/security gates, then the
GitHub -> Gitee -> Coolify deployment and public endpoint evidence chain.
