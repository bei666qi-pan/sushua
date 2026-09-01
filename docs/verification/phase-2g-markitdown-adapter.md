# Phase 2g MarkItDown Adapter verification

Date: 2026-09-01

## Scope

- Add MarkItDown 0.1.7 for HTML, DOCX, PPTX and XLSX fallback parsing.
- Keep `DocumentProcessingService` and `sushua.document-ir.v1` as the stable boundary.
- Use pinned Python 3.13.15 Debian slim because ONNX Runtime has no musllinux wheel.
- Keep Docling out of this image and deliver it as a separate follow-up image.

## TDD evidence

- The initial Parser contract failed because `MarkItDownParser` did not exist.
- The corrupt DOCX case exposed MarkItDown's plain-text fallback; the Adapter now validates the Office package marker before conversion.
- The high-expansion archive contract first returned `invalid_document_content`; it is now rejected as `document_archive_budget_exceeded` before conversion.
- The HTTP integration contract failed with the Parser registration removed and passed after registration was restored.
- The container contract failed on Alpine because `onnxruntime==1.20.1` has no musllinux wheel, then passed on the pinned Debian slim image.

## Fresh local verification

- `npm run document:test`: 6 tests passed for HTML, DOCX, PPTX, XLSX, corrupt Office and archive expansion.
- `npx tsx test/document-service-http.test.ts`: real HTTP object-to-IR paths passed for plain text and HTML.
- `npm run test:container`: numeric non-root, read-only root, no capabilities, no-new-privileges and runtime MarkItDown conversion passed.
- `npm run ci:verify`: exit 0 with real PostgreSQL, Redis and ClamAV services; tests, types, lint, Next build, npm audit and pip-audit passed.
- Syft 1.51.1 generated CycloneDX and SPDX output successfully.
- Gitleaks 8.30.1 scanned 97 commits and 3.28 MB with no leaks found.
- Trivy 0.74.0: Python packages had 0 findings; Debian base layer had 13 HIGH and 3 CRITICAL without fixed versions.
- Grype 0.118.0: reported unfixed HIGH/CRITICAL in Debian libc, Perl, ncurses, gzip, ACL and SQLite packages; Python dependency audit remained clean.

Document Service image scans remain visible but are non-blocking under the user-approved MarkItDown exception. Repository, Web image and ClamAV image scans remain blocking. This is local implementation evidence only and is not deployment evidence.
