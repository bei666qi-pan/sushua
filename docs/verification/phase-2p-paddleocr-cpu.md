# Phase 2p PaddleOCR CPU verification

Date: 2026-09-03

## Scope

- Keep MarkItDown 0.1.7 as the lightweight HTML, DOCX, PPTX and XLSX fallback.
- Add a real PaddleOCR 3.7.0 CPU Adapter to the independent Docling Debian slim image.
- Route JPEG and PNG through the existing OCR seam only when both
  `PADDLE_OCR_ENABLED` and `DOCLING_OCR_IMAGE_ENABLED` are enabled.
- Keep both capability flags disabled by default. Scanned PDF OCR remains disabled.
- Pre-bake the model files during the image build and validate every file before the
  process becomes ready. A task never downloads a model at runtime.
- Support Linux x86_64 only in this increment. PaddlePaddle 3.3.1 does not publish the
  required Linux ARM64 wheel; Apple Silicon verification therefore uses Docker amd64
  emulation.

## TDD evidence

The implementation was driven through focused RED -> GREEN cycles:

1. The first contract failed because the Paddle Adapter did not exist. The minimal
   Adapter then mapped real Paddle `predict` output into the existing `OcrResult` seam.
2. Independent failing cases covered mismatched text/score/box counts, blank text,
   boolean or out-of-range confidence, missing fields, page-index confusion, invalid
   boxes and polygon/box disagreement. Malformed output now fails closed.
3. Enabling Paddle without the exact model artifact tree initially did not provide a
   safe startup contract. The service now refuses to start when files are missing,
   modified, additional or symbolic links.
4. A malicious tar whose manifest entry was `../escaped.bin` first wrote outside the
   model output directory and then reported only an integrity mismatch. Archive member
   paths are now checked before output creation; the same test reports
   `paddle_model_archive_invalid` and creates no escaped file.
5. An empty Paddle prediction was first misclassified as retryable inference failure.
   It is now classified as non-retryable invalid provider output.
6. The container contract initially failed while Debian packages followed a stale
   Docker Desktop proxy. Only the affected image build commands now clear inherited
   proxy variables; no host, Docker Desktop or Shadowrocket setting was changed. The
   same full container contract then passed.

Fresh focused verification completed 22 Docling tests and 25 Document Service tests.
Strict mypy checks covered both services, and Ruff reported no findings.

A final `ci:verify` with isolated PostgreSQL, Redis and real ClamAV completed with
exit code 0. It covered both Python syncs, all unit/Golden/real integration tests,
both restricted container contracts, TypeScript and strict mypy, ESLint and Ruff,
the Next.js 15.5.24 production build, npm audit and both Python audits. npm reported
one moderate `@xmldom/xmldom` advisory and no HIGH/CRITICAL finding. The Document
Service Python audit found no known vulnerability; the macOS Docling audit found no
known vulnerability after the existing time-bounded Darwin-only Transformers exception.
The separate Linux x86_64 export audit below covers the production Paddle dependency
branch.

## Model and fixture provenance

The production Adapter uses these CPU models:

| Artifact | Archive SHA256 |
|---|---|
| `PP-OCRv5_mobile_det_infer.tar` | `50446e5d01ac2a73d5319c89513281f6578414c888c602f9af13f93feefffc58` |
| `PP-OCRv5_mobile_rec_infer.tar` | `566b9512b34e34a9f0db54d87b51fa5a0b9ed2cf1ab7e49728cc0b8b5a64f414` |

The six extracted inference files also have fixed sizes and SHA256 values in the
downloader manifest. Extraction accepts only regular files and directories, requires
the exact manifest set, rejects path traversal and symbolic links, and removes partial
output after any failure.

The Golden image is PaddleOCR's Apache-2.0 Chinese fixture
`docs/datasets/images/ch_doc1.jpg` at upstream commit
`2661c7c0ef5c613e8f93c6e93b2e052399f0f854`. Its decoded SHA256 is
`19588f23a55ded05245de1fcfdfe2425b1ee913522d16d743d4f04306b878dee`.

## Real container evidence

The latest runtime source was exercised in local amd64 image
`sha256:06025955bd0615f6439cdd745a68096dc02822a455d9c9a1015fd07c4002899d`.
It is an amd64 image of 986,403,304 bytes and runs as numeric user
`10001:10001`.

With network disabled, a read-only root filesystem, all capabilities dropped,
`no-new-privileges`, a bounded tmpfs and pre-baked models, the real Adapter returned:

```json
{
  "text": "如，和对旅游表演形式",
  "bbox": [3, 1, 278, 30],
  "confidence": 0.9967620968818665,
  "cv2Version": "4.10.0",
  "doclingImport": "DocumentConverter"
}
```

The normal host-architecture container contract also passed after rebuilding both
document images. It converted a real DOCX and a two-page native PDF without network,
preserved PDF provenance, passed a private `0600` object between the two numeric-user
containers, rejected invalid service authentication, and did not read `/etc/passwd`
through a malicious ODF external-image reference. The host image is ARM64, so that
contract explicitly skipped Paddle inference; the separate amd64 run above is the real
Paddle evidence.

A clean amd64 Dockerfile rebuild reached all 141 locked dependencies and system
packages but was interrupted while downloading the already pinned Docling layout model:
Hugging Face repeatedly returned `SSL: UNEXPECTED_EOF_WHILE_READING`. For current-source
runtime verification, the previously hash-validated amd64 image was used as the base and
only `/app/docling_service` was replaced. This is local runtime evidence, not proof that
a clean release build succeeds. GitHub CI must still rebuild the complete Dockerfile.

## Dependency audit and dual image scan

`pip-audit==2.10.1` ran inside Linux x86_64 against the frozen production export and
reported no known vulnerabilities. The internal path package has no registry version,
and PyPI cannot audit the official `torch==2.13.0+cpu` and
`torchvision==0.28.0+cpu` index builds; those three skips remain explicit limitations.

The current-source amd64 image was scanned independently with Trivy 0.74.0 and Grype
0.118.0. Full machine-readable reports remain local build evidence and CI repeats both
scans for every commit.

| Scanner report | Total | HIGH | CRITICAL | Python package HIGH/CRITICAL | SHA256 |
|---|---:|---:|---:|---:|---|
| Trivy JSON | 181 | 22 | 5 | 0 | `1974253981f5e3da8f8f519c6a9121500028b5f2e32179b6a56b2c3d2b7e233d` |
| Grype JSON | 238 | 63 | 10 | 0 | `48074ce580a17499e288cc39f11c796db5799ae6a8e52e27705c94d7e62977c4` |

Trivy assigns all 181 findings to Debian 13.6 OS packages. Its 27 HIGH/CRITICAL
matches cover `gzip`, `libacl1`, `libexpat1`, `libglib2.0-0t64`, `libncursesw6`,
`libsqlite3-0`, `libsystemd0`, `libtinfo6`, `libudev1`, `libxml2`, `ncurses-base`,
`ncurses-bin` and `perl-base`; the Python-package result contains zero findings.

Grype reports 163 Debian matches (28 HIGH, 9 CRITICAL) and 75 binary matches (35 HIGH,
1 CRITICAL). The binary findings are the Python 3.12.14 runtime and FFmpeg 5.1.4 shared
libraries embedded in PaddleX's required `opencv-contrib-python==4.10.0.84` and the
aligned `opencv-python==4.10.0.84` wheel. A controlled OpenCV 5.0.0.93 probe removed the
FFmpeg CRITICAL but still reported 17 HIGH findings and conflicts with PaddleX 3.7.x's
exact OpenCV 4.10 requirement, so the production lock was not overridden merely to
reduce scanner counts.

Under the user-approved document-image policy, these Debian/runtime/native-wheel image
findings are fully reported but do not absolutely block this isolated document image.
Known Python dependency findings from the frozen package audit remain blocking. The
compensating controls are an internal-only service, no business database credentials,
short-lived object references, numeric non-root, read-only root, dropped capabilities,
`no-new-privileges`, bounded tmpfs, task-time network denial and pre-baked hashed models.

## Release boundary

This increment proves real offline CPU OCR for JPEG and PNG through the internal Adapter.
It does **not** prove scanned-PDF OCR, phone-photo preprocessing, public upload routing,
production enablement, or completion of Phase 2/P0. No feature flag is enabled by
default. A production claim requires green PR/main CI, matching GitHub and Gitee SHAs,
a finished healthy Coolify deployment, matching public health version and a real public
upload -> job -> parse causal chain.
