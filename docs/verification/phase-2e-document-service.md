# Phase 2e: Document Service HTTP contract

## Scope

This increment replaces the parser HTTP fake at the Node boundary with a real FastAPI process for
the smallest deterministic path:

- authenticated `POST /v1/parse`;
- local isolated-object `StorageAdapter` for contract and end-to-end tests;
- UTF-8 `text/plain` and `text/markdown` `DocumentParser`;
- deterministic `sushua.document-ir.v1` object write and SHA256 result;
- minimal `/health/live` and `/health/ready` responses.

It does **not** add the production S3 Adapter, container, Docling, MarkItDown, PaddleOCR or OpenCV.
PDF, Office, scan and photo parsing remain unsupported by this service increment.

## TDD evidence

The first contract run failed because `services/document-worker` and `uvicorn` did not exist. After
the minimal service was added, the real Node `DocumentServiceClient` reached the FastAPI process,
read a source object using the same tenant key shape as upload v1, wrote IR, and independently
verified the result hash. The test also rejects an invalid token, extra request fields and a foreign
Workspace object key, and checks captured service output for source text or token leakage.

## Verification command

```bash
TEST_DATABASE_URL=<isolated-postgres> \
TEST_REDIS_URL=<isolated-redis> \
TEST_CLAMAV_HOST=<isolated-clamd-host> \
TEST_CLAMAV_PORT=<isolated-clamd-port> \
npm run ci:verify
```

The gate synchronizes the frozen Python lock, runs the real Document Service HTTP test and existing
PostgreSQL/Redis/ClamAV suites, then runs TypeScript and strict mypy checks, ESLint and Ruff, the
Next.js production build, and npm plus pip audits.
