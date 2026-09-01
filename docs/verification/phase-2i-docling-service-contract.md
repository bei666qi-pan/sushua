# Phase 2i Docling internal service contract verification

Date: 2026-09-01

## Scope

- Add a private Docling HTTP service with `live`, `ready`, and `/v1/convert` endpoints.
- Accept only a strict, versioned tenant object reference contract; arbitrary URLs, host paths,
  unknown fields, cross-tenant keys, unsupported MIME types, and integrity mismatches fail closed.
- Write immutable `sushua.docling-output.v1` JSON to the bounded DocumentVersion conversion key.
- Extract the shared object-reference models and Local/S3 storage adapters into the internal
  `sushua-document-service-core` Python package used by both document images.
- Keep the existing Document Service as the only Job Worker-facing parsing boundary. This change
  does not route production `document.parse` jobs to Docling yet.

## TDD evidence

The first real HTTP contract run failed because the Docling project had no `uvicorn` executable or
`docling_service.app` entrypoint. After the service was implemented, a cold import measurement showed
Docling/Torch needed about 84 seconds on the local CPU; the readiness test budget was raised from 60
to 120 seconds without weakening request or storage checks.

The contract then verified:

- real DOCX conversion through object storage with output SHA256 verification;
- Bearer token authentication, tenant prefix enforcement, source size/SHA verification, supported
  MIME allowlisting, strict request fields, and safe error codes;
- no source text or service token in application logs;
- real container execution with no network, read-only root, numeric non-root user, all capabilities
  dropped, `no-new-privileges`, and writable bounded object storage;
- the existing MarkItDown Document Service remained functional after extracting shared storage.

## Release boundary

This is an internal service and image contract only. It is not deployed, is not mirrored to Gitee,
and does not prove the production parser route uses Docling. The next increment will add the
DocumentProcessingModule Adapter and deterministic conversion from Docling output to Document IR.

## Fresh verification

- `ci:verify`: exit 0 with the isolated PostgreSQL, Redis, and ClamAV services; all Node/Python
  tests, both real container contracts, TypeScript/mypy, ESLint/Ruff, Next.js production build,
  npm audit, and both pip-audit runs completed successfully.
- Trivy 0.74.0: both final document images report Debian 13.6 with 13 HIGH and 3 CRITICAL;
  each Python package result contains 0 HIGH/CRITICAL. This is the documented non-blocking image
  exception, not a zero-vulnerability claim.
- Grype 0.118.0 secondary reports were generated for both final images. High/critical match counts
  are 20/7 for Document Service and 38/7 for Docling; Python-type high/critical matches are 0 in
  both reports. Counts differ from Trivy because scanner matching and package classification differ.
- Syft 1.51.1 generated CycloneDX and SPDX JSON for both images. Gitleaks 8.30.1 scanned 100 commits
  (about 3.62 MB) and found no leaks.
- The original dirty workspace remained at `064093a87c95ff470e73d046dab898467082d1ea`; its tracked and
  untracked user-owned change list was unchanged.
