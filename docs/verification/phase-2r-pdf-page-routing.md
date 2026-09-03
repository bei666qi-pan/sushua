# Phase 2r PDF page routing verification

Date: 2026-09-03

## Scope

- Keep MarkItDown 0.1.7 as the Office/HTML fallback.
- Add automatic PDF routing at page granularity inside the isolated Docling image.
- Preserve native Docling content for searchable pages and send only low-text pages to PaddleOCR.
- Define manual overrides: `ocr=false` forces native, `ocr=true` forces OCR, and an absent `ocr` field selects automatic routing.
- Persist each page's route, non-whitespace character count and reason through the Docling output into Document IR.
- Keep all existing Docling/Paddle PDF capabilities disabled by default.

## RED -> GREEN evidence

The first focused run produced three assertion failures and two errors against the previous whole-document selection behavior. It showed that automatic mode never called OCR for blank pages, emitted no routing evidence, did not fail when an OCR-required page lacked the capability, and did not provide selected page numbers to forced OCR.

After implementation, the focused routing suite covers two native pages, two scanned pages, a mixed native/scanned PDF, both manual overrides, missing OCR capability and the 100-page budget before model inference. The real Paddle Adapter test also proves that selecting page 2 renders only page 2. Document Service tests verify that allow-listed routing evidence survives conversion and is persisted in Document IR.

`npm run ci:verify` completed with exit code 0 against the isolated PostgreSQL 17 + pgvector, Redis and ClamAV instances. It included Python and TypeScript tests, the document/S3/Docling HTTP contracts, RLS and queue integration, restricted-container contracts, type checks, lint, production build and dependency audits. The npm audit result contains the already-known single moderate `@xmldom/xmldom` advisory and no HIGH/CRITICAL findings; both Python audits reported no known vulnerability, subject to the documented local-package and Darwin audit limitations.

The host is Apple Silicon, so the ordinary container contract correctly skipped Paddle's amd64-only runtime probe. To cover the changed page-selection implementation, the current code was additionally built as an isolated `linux/amd64` image and the real PaddleOCR probe ran under the same no-network, read-only-root, non-root and drop-all-capabilities restrictions. It returned the expected Chinese text, bbox and `0.9967620968818665` confidence; its selected-PDF result was exactly `selectedPdfPages: [2]`.

## Release boundary

This increment is an internal routing primitive. It does not enable any production capability flag, open OCR in the public upload flow, prove phone-photo preprocessing, or complete Phase 2/P0. Production publication requires the PR/main gates and the complete GitHub -> Gitee -> Coolify -> public endpoint chain. Public OCR enablement additionally requires a real upload -> scan -> job -> parse causal test.
