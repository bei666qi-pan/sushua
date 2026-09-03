# Phase 2q scanned PDF OCR verification

Date: 2026-09-03

## Scope

- Keep MarkItDown 0.1.7 as the Office/HTML fallback.
- Extend the real PaddleOCR 3.7.0 CPU Adapter to scanned PDFs by rendering one page at a time with the already locked `pypdfium2` 5.13.0 runtime.
- Preserve page order, rendered pixel dimensions, OCR bbox and confidence through `OcrResult` and Document IR conversion.
- Require separate `DOCLING_OCR_PDF_ENABLED` and `PADDLE_OCR_PDF_ENABLED` capability switches in addition to the existing Paddle switch. All remain disabled by default.
- Treat only boolean `parseConfig.ocr=true` as a PDF OCR request. Missing `ocr` selects the native path; invalid types fail closed.

## RED -> GREEN evidence

The first focused runs failed because the production Adapter rejected `application/pdf`, had no `supports` contract, treated a missing OCR setting as enabled, did not enforce PDF budgets and collapsed safe deterministic failures into a generic error.

After the implementation:

- 27 focused Docling tests passed, covering real PDFium rendering with a fake external inference engine, explicit capability selection, malformed PDFs, 100-page limit, per-page and total pixel budgets, output validation and safe error translation.
- 20 focused Document Service Adapter tests passed.
- The two-service HTTP contract passed and preserves only allow-listed OCR failure codes; arbitrary provider errors remain hidden.
- Strict mypy and Ruff checks passed for both Python services. `pypdfium2` is installed but does not publish a `py.typed` marker, so only that import has a precise `import-untyped` ignore.

## Real isolated container evidence

A clean amd64 build from the current Dockerfile completed successfully and produced:

- image: `sha256:84adf9477a553cc79c14c95a8cbb73b0241619a0e495580db2e91e89bc849200`
- architecture: `amd64`
- size: 986,418,198 bytes
- configured user: `10001:10001`

The probe ran with no network, a read-only root filesystem, all capabilities dropped, `no-new-privileges`, a bounded tmpfs and the pre-baked hash-validated Paddle models. The upstream Apache-2.0 Chinese JPEG was wrapped as a two-page scanned PDF and the real Adapter returned:

```json
{
  "text": "如，和对旅游表演形式",
  "bbox": [3, 1, 278, 30],
  "confidence": 0.9967620968818665,
  "pdfText": "如，和对旅游表演形式",
  "pdfPages": 2,
  "pdfSize": [560, 64],
  "pdfBbox": [6, 3, 556, 60],
  "cv2Version": "4.10.0",
  "doclingImport": "DocumentConverter"
}
```

This is real Paddle inference, not the fixture Adapter used by the fast service contract tests.

## Full gate and image disclosure

The final local `npm run ci:verify` completed with exit code 0 against isolated PostgreSQL 17 + pgvector 0.8.6, Redis 8.2.1 and real ClamAV 1.5.4. It covered all Python and TypeScript tests, RLS and queue integration, both restricted container contracts, strict type checks, lint, the Next.js production build and dependency audits. npm reported the existing one moderate `@xmldom/xmldom` advisory and no HIGH/CRITICAL result. Both Python audits reported no known vulnerability, subject to the already documented local path package and Darwin-only audit limitations.

The clean amd64 image above was then scanned independently with current Trivy 0.74.0 and Grype 0.118.0 databases:

| Scanner report | Total | HIGH | CRITICAL | Python package HIGH/CRITICAL | SHA256 |
|---|---:|---:|---:|---:|---|
| Trivy JSON | 181 | 22 | 5 | 0 | `916297036485e3b5087aa9df0437d6abbe0ab50c2cf645df355725f0bba40f72` |
| Grype JSON | 238 | 63 | 10 | 0 | `967476a3dfe4f7116c630dc528d215485978000c37f473852df1fe2090ee064b` |

Trivy assigns all findings to Debian 13.6 OS packages. Grype reports 171 Debian matches (28 HIGH / 9 CRITICAL) and 67 binary matches (35 HIGH / 1 CRITICAL); no Python-type HIGH/CRITICAL match exists. These results remain the user-approved, fully disclosed document-image OS/runtime/native-binary exceptions, not a zero-vulnerability claim. No host, Docker Desktop or Shadowrocket proxy setting was changed; only the two one-shot scanner containers had inherited proxy variables cleared.

## Resource and failure policy

- Render scale is fixed at 2 (144 DPI for ordinary 72-point PDF pages).
- Maximum 100 pages.
- Maximum 40,000,000 rendered pixels per page.
- Maximum 300,000,000 rendered pixels per document.
- All budgets are checked before any page is rendered or sent to Paddle.
- Malformed PDFs, invalid OCR output and page/pixel limits become finite public error codes. Unknown internal errors and paths are still replaced by `ocr_failed`.

## Release boundary

This increment proves the real internal scanned-PDF primitive and its error contract. It does **not** enable OCR flags, classify native versus scanned pages automatically, wire the public upload flow to `parseConfig.ocr=true`, prove phone-photo preprocessing, or complete Phase 2/P0. Production publication still requires PR/main gates and the full GitHub -> Gitee -> Coolify -> public endpoint chain; public OCR enablement additionally requires a real upload -> scan -> job -> parse causal test.
