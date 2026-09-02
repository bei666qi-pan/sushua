# Phase 2k native PDF Document IR verification

## Scope

This increment adds an internal, default-off native PDF -> Document IR primitive:

- keep MarkItDown 0.1.7 for HTML, DOCX, PPTX and XLSX fallback;
- run Docling 2.124.0 in its own Python 3.12 Debian slim image;
- pre-bake and verify the fixed Layout Heron model revision;
- use `PyPdfiumDocumentBackend` with OCR, table extraction, remote services,
  external plugins, local fetch and remote fetch disabled;
- preserve real page numbers, page dimensions, complete character spans and
  source bounding boxes through the Document Service Adapter;
- fail closed on partial conversion, missing pages/provenance, disjoint or
  cross-page provenance, invalid geometry, empty pages and unsupported structure.

The user explicitly approved preserving MarkItDown and not treating Alpine or
zero HIGH/CRITICAL findings in the two Debian document images as selection goals.
Both images are still scanned and all findings are disclosed below.

## Product and release boundary

`DOCLING_NATIVE_PDF_ENABLED` is an internal capability kill-switch, not a
product Feature Flag. It defaults to `false`, and a controlled request must also
carry `parseConfig.ocr=false`. The upload path currently creates a
`DocumentVersion` with an empty parse config, so enabling this switch does **not**
make the upload -> Job -> PDF product path available. Production configuration
must keep it disabled until a versioned parse-config API and a real upload Job
E2E are delivered.

This increment does not include OCR, scanned PDFs, photos, full table/formula
mapping, Gitee mirroring, Coolify deployment or public endpoint verification.
It is repository/local evidence, not evidence that the feature is online.

## RED -> GREEN evidence

The new contracts caught the following pre-existing or first-pass failures:

1. PDF was not a registered Docling Adapter capability and had no page/bbox IR
   contract.
2. Docling can return `PARTIAL_SUCCESS` without raising; only
   `ConversionStatus.SUCCESS` is now publishable.
3. A configured but invalid model directory could previously appear ready;
   readiness now validates every expected artifact.
4. The default PDF backend did not freeze the no-fetch PDFium policy.
5. The first dependency resolution selected Transformers 5.8.1 and
   `pip-audit` reported CVE-2026-9856. Trying 4.57.6 increased the result to six
   findings, and the minimum fixed 5.10.0 is yanked by upstream. The final lock
   selects 5.8.1 only for Darwin and non-yanked 5.16.1 for non-Darwin targets.
6. A parallel Trivy run exposed its shared-cache lock; final scans were run
   sequentially. The repository scan also demonstrated that a universal lock is
   not platform-aware, so the unavoidable Darwin CVE exception is path-scoped
   in `.trivyignore.yaml` and expires on 2026-09-09.
7. A candidate local gate exposed two test-harness timing windows under sustained
   host load: Document Service startup spent most of its time in the retained
   MarkItDown import graph, and a BullMQ retry reached `succeeded` in PostgreSQL
   after the five-second QueueEvents notification window expired. Only the real
   integration-test waits were widened; no fixed sleeps were added.
8. Review rejected an attempted increase of the shared Job Worker's Document
   Service timeout from 120 to 960 seconds. The existing lease has no renewal or
   attempt fencing, `claim_job_v1` compares caller-provided clocks, and active
   cancellation does not abort an in-flight request. Increasing a numeric lease
   would only mitigate those gaps, not fix them. The attempted Worker config
   change was removed: this increment keeps the existing production Job lease
   and outer request timeout unchanged. Native PDF is proven only at the direct
   Document Service boundary and remains unavailable through the product Job
   path until database-clock leasing, attempt fencing and active cancellation
   are delivered in a separate increment.
9. The first GitHub Linux run reached the real PDF -> IR boundary but returned
   `docling_output_unavailable`. Failure diagnostics proved both containers were
   running with `oom=false`: Docling could read its `10002:10002 / 0600` atomic
   output while Document Service `10001:10001` could not. A Docker named-volume
   contract reproduced the same `PermissionError` on macOS before the fix. The
   minimal correction aligns Docling to the existing `10001:10001` private local
   storage identity; the output remains `0600`, and service/container/token
   isolation is unchanged. A shared-group design was not introduced without a
   complete volume initialization and directory-permission contract.
10. A fresh full gate later exposed that only the Docling audit carried the
    documented 60-second socket timeout; Document Service still inherited
    `pip-audit`'s 15-second default and failed on a PyPI TLS handshake. A command
    contract failed against the real npm script before `document:audit` was
    corrected to pass `--timeout 60`. Vulnerability thresholds and ignores were
    not changed.
11. Failure preservation review found that the first diagnostics implementation
    replaced the original child-process error with a new `Error`, could itself
    throw when `spawnSync` returned no stderr, and copied arbitrary HTTP bodies
    and container logs into CI output. Focused contracts first failed on exact
    error identity, a missing Docker executable, a throwing stderr sink and a
    synthetic private log. Diagnostics now return the exact primary object,
    remain non-throwing after a primary failure, omit container log content and
    format only allowlisted process metadata. A real running Document Service
    401 probe initially printed its JSON body and traceback; the same probe now
    emits only HTTP status, bounded error code and retryability.

## Focused functional evidence

- Document Service: 23 Python tests cover Docling routing/IR validation and the
  retained MarkItDown HTML/DOCX/PPTX/XLSX fallback.
- Docling Service: 6 Python tests cover model readiness, PDFium/offline policy,
  OCR rejection, missing models, partial result and failed result handling.
- The real two-container contract builds both images and runs with no network,
  read-only roots, all capabilities dropped, `no-new-privileges` and numeric
  non-root users. A controlled two-page PDF produced two `612 x 792` pages,
  four exact text blocks, complete char spans, in-page BOTTOMLEFT provenance,
  normalized TOPLEFT Document IR boxes, stable reading order, unique Block IDs
  and matching output SHA256.
- A named-volume contract runs the real shared `LocalObjectStorage` writer from
  the Docling image and reader from the Document Service image. It requires the
  owner-only `0600` object to cross the service boundary between two separately
  built images whose local-storage identity is `10001:10001`, avoiding Docker
  Desktop bind-mount permission shortcuts without making the file group/world
  readable.
- A fast failure-evidence contract preserves the exact primary error through
  diagnostics and cleanup failures, tolerates unavailable command output, and
  proves that raw container logs and arbitrary error messages are not emitted.
  The full container contract separately exercises a real HTTP 401 and accepts
  only its status, error code and retryability marker.
- The same contract proves the retained real DOCX route and rejects an ODT
  external-image attempt without reading container files.
- The Linux image contract now directly asserts `transformers==5.16.1` before
  conversion; lock-file inspection alone is not accepted as runtime evidence.

## Local full gate

Final `ci:verify` result: **exit 0**. The candidate run started at
`2026-09-02 19:13:38 +0800` and completed at `19:24:31 +0800` against isolated
PostgreSQL 17 + pgvector 0.8.6, Redis 8.2.1 and ClamAV 1.5.4 instances.

The same run completed 23 Document Service tests, 6 Docling policy tests, all
scripted Node unit/Golden/real-service integration contracts, both hardened
container contracts, TypeScript and Python type checks, ESLint and both Ruff
checks, and a Next.js 15.5.24 production build with all 7 static pages generated.
The run includes the audit-command contract, failure-preservation contract,
owner-only named-volume handoff, real 401 metadata probe and two-page PDF -> IR
conversion. `npm audit --omit=dev --audit-level=high` returned 0 vulnerabilities.
Both Python audits reached their final result with the explicit 60-second
timeout and reported no known vulnerabilities; the internal
`sushua-document-service-core` package is not published on PyPI and was reported
as unauditable rather than silently treated as clean. The macOS Docling result
also reported its one documented, expiring Darwin-only Transformers ignore.

Two preceding full runs reached the final Docling audit only after the earlier
gates had passed, then failed closed on a PyPI TLS handshake timeout at
`pip-audit`'s old 15-second default. The current command demonstrably receives a
60-second socket timeout; switching to OSV did not remove the same network
failure mode, so the default PyPI source remains in use. No vulnerability rule
or severity threshold was relaxed.

Local macOS audit wording is deliberately `0 remaining / 1 ignored`, not
"zero vulnerabilities": Docling IBM Models constrains Darwin to
`transformers<5.9`, and no compatible fixed release exists. Ubuntu CI and the
Linux production image use 5.16.1 without this ignore.

## Reproducibility snapshot

Captured on 2026-09-02 on Darwin arm64 from branch
`feat/p2-native-pdf-ir`, base commit
`4bebd671f3a00bebd5c42ba0ef60813ef54f5a25`.

| Input | SHA256 |
|---|---|
| `package-lock.json` | `29f263175c21af5da4b184b4c3b3c3fa5d7249b79beba7a7cf2bd307ec6496d8` |
| `services/document-worker/uv.lock` | `e42a851ab91ae4aa378cd9e1a940304930c3919a848430cfd024947705e7ee77` |
| `services/docling-worker/uv.lock` | `98cf692ca0649df37ee8863af678830bdaf70a7ca3fcae7477225ec629650774` |
| Web Dockerfile | `9eddc23201ba52ebdc2717b3a95afac0a30ef5d1b3d650c8de3725e99c67b0d4` |
| Document Service Dockerfile | `d388bc6e5186e7c55bb8047eb6f2728c2139901ff893af75592d8ecc02b70408` |
| Docling Dockerfile | `2c42d1b0ad778258de987dd0e90ad436e215785e3b1e5fd07dd0c533d95348d0` |

These are local BuildKit image IDs/manifest-list IDs, not registry or deployment
digests:

| Image | Local ID | Architecture | Bytes | Runtime user |
|---|---|---:|---:|---|
| `sushua:phase-2k-local` | `sha256:3b601368f9abfdba4d4fb085ad14b1488bccddc6850e57db45fe138168a05d6d` | arm64 | 82,231,756 | `node` |
| `sushua-document-worker:phase-2k-local` | `sha256:27ab09ba4decd6b46e7f540b27dd8efeaa84797be9c8e21d041417b1bb14ddc8` | arm64 | 126,737,135 | `10001:10001` |
| `sushua-docling-worker:phase-2k-local` | `sha256:9443285a0a78cf296e941c5b8cf3587876564991e4a36aa4b0f97c7b67539325` | arm64 | 591,014,701 | `10001:10001` |

The Docling image runtime reported Docling 2.124.0, docling-core 2.92.0,
Transformers 5.16.1, Tokenizers 0.23.1, pypdfium2 5.13.0 and
PyTorch 2.13.0+cpu. The separate Document Service image reported MarkItDown
0.1.7 and runtime UID/GID `10001:10001`.

The first fixed-tag Web rebuild inherited a stale Docker Desktop proxy endpoint
and failed with `ECONNREFUSED` before installing dependencies. The successful
rebuild explicitly cleared build-only proxy arguments for that command; no
Shadowrocket, Docker Desktop or repository configuration was changed.

## Model manifest

Repository: `docling-project/docling-layout-heron`; immutable revision:
`8f39ad3c0b4c58e9c2d2c84a38465abf757272d8`.

| File | Bytes | SHA256 |
|---|---:|---|
| `.gitattributes` | 1,519 | `11ad7efa24975ee4b0c3c3a38ed18737f0658a5f75a0a96787b576a78a023361` |
| `README.md` | 3,219 | `175700839bc7808eac6af1d0c23e4f483606ab2276fe01122f4093e61a1a65b6` |
| `config.json` | 3,268 | `fdea30805ce2f5666b147fca941dcdd27ad468e27d6ed21902207d3da056a97d` |
| `docling_heron_400.png` | 96,925 | `e7f78610372b32a7938e480d2c7fa1c3037ee170bd82282a5bd026232f6e6f9e` |
| `model.safetensors` | 171,658,996 | `00333a43451945aaf89db8ca9c0a17e75d1537c17db60fdb91aa95f4c7929e0c` |
| `preprocessor_config.json` | 444 | `cd38cd59999e7a95d68e487fbe5132df3d4e5c32a0836add57e6126ba0c4eaf1` |

The SHA256 of the sorted `path<TAB>bytes<TAB>sha256<LF>` manifest is
`efa548d16f02835af33c19f3fb544c2bba0eec0961d04cc73fe5bf9f7e8dacce`.
Runtime model download is disabled and the service is not ready if this manifest
does not validate.

## Dependency and image scans

Tools were downloaded from their official GitHub releases and their release
checksums were verified before use: Trivy 0.74.0, Grype 0.118.0, Syft 1.51.1
and Gitleaks 8.30.1.

The local report hashes in the two tables below were captured from the candidate
before the UID-only Docling image correction. They remain useful disclosure of
the unchanged Debian/Python package set, but they are **not** used as final-image
approval evidence. The final PR head must be rebuilt and rescanned by GitHub
Security; its logs and artifacts are authoritative.

Trivy DB v2 was updated at `2026-09-02T01:09:54Z`. The repository's raw result
contained one HIGH finding: the Darwin-only Transformers 5.8.1 lock entry. With
the path-scoped, expiring exception, the blocking repository result is 0. Web
and ClamAV blocking scans are also 0. The two Debian document-image scans are
non-blocking disclosures:

| Trivy JSON | HIGH | CRITICAL | Fixed | Unfixed | Report SHA256 |
|---|---:|---:|---:|---:|---|
| repository, approved exception applied | 0 | 0 | 0 | 0 | `29f953d52ff739a153e735e6212a8f34b54c969620473dbc204dc0a556e7cbc3` |
| Web | 0 | 0 | 0 | 0 | `af40e1df46f174ff8591535912fd5b8bb4edbcea01feb7a2a1b817a312447e86` |
| ClamAV 1.5.4 fixed digest | 0 | 0 | 0 | 0 | `123c4e1564fbd97a12afcfc355f05f8e8951218882598bca48da70895e0c6ab3` |
| Document Service, non-blocking | 13 | 3 | 0 | 16 | `8e767543acfca51757ee9eefec7fa71b7b6ea82e6c58f2af293a02925ce9949b` |
| Docling, non-blocking | 13 | 3 | 0 | 16 | `aa273de8f4f2e0f05eec3cd4837e41af94dbefef84c96bbbb70f0903d7847ad5` |

Both document Trivy reports place all 16 findings in Debian OS packages and
report 0 Python-package HIGH/CRITICAL findings.

Grype used manually imported DB schema v6.1.9 built at
`2026-09-01T06:32:09Z`; automatic updates were disabled during the scans. It is
an independent direct-image scan, not a claim that Grype consumed the Syft
SBOMs:

| Grype JSON | HIGH | CRITICAL | Fixed | Unfixed | Report SHA256 |
|---|---:|---:|---:|---:|---|
| Web, blocking | 0 | 0 | 0 | 0 | `2ac404bed0e5adae6bc50699f4af8330e4eaf4f0014978e05005e03595980941` |
| Document Service, non-blocking | 20 | 7 | 0 | 27 | `16e200d2fdf9c5ccd763e1cbfcd9ad4d900ad7fbaf87dd7b30baabf55db1a593` |
| Docling, non-blocking | 38 | 7 | 4 | 41 | `034936c122311abff20b0bb25e4bcd6de6ab2ea8c2c856d06683420d30468ff2` |

The Document Service findings are Debian packages. Docling adds binary findings
from the parser/runtime image; its Python packages do not include a Transformers
HIGH/CRITICAL match. Full machine-readable reports remain local temporary
evidence; GitHub Security logs are authoritative for the final PR head.

Strict `pip-audit 2.10.1` against the actual Linux image site-packages returned
no known vulnerabilities. It explicitly could not resolve the internal
`sushua-document-service-core` package or PyTorch CPU private-index builds from
PyPI; the image scanners and SBOM preserve those components for secondary
inspection.

## Pre-fix SBOM snapshot

All six candidate files parsed as JSON before the UID-only image correction.
They are retained as a package-inventory baseline, not attributed to the final
local image IDs above. The Layout Heron model is not a package and is therefore
covered by the separate manifest above.

| SBOM | Schema | Components/packages | Bytes | SHA256 |
|---|---|---:|---:|---|
| `sbom.cyclonedx.json` | CycloneDX 1.7 | 509 | 397,434 | `8b4ea846f6d305b1b6c4972af7a01a2646121358c27576ea984ff1a99d52f9d6` |
| `sbom.spdx.json` | SPDX 2.3 | 224 | 610,375 | `ee6335cf4d80bdec0d303b3f9cec3ec7908c63fe291b5015447c7e96c6d60de6` |
| `document-service.sbom.cyclonedx.json` | CycloneDX 1.7 | 2,907 | 1,143,036 | `8f4cae0b4a9f11c5f1a299e65584837d70db90d1de3fd2c7648053f5b1aaf3ed` |
| `document-service.sbom.spdx.json` | SPDX 2.3 | 138 | 2,610,569 | `521b160739443b89284a6dec4329f17888131c59a886db006338716fccb19a5e` |
| `docling.sbom.cyclonedx.json` | CycloneDX 1.7 | 3,196 | 1,539,478 | `6a69ba03eb0b7e32128124fd2ba4d34ea9d7fb234c280c899e5550cf618da2bd` |
| `docling.sbom.spdx.json` | SPDX 2.3 | 221 | 3,393,979 | `43c73431d8985ff36be18e34e3f7751708ec7ad59a4e0822fc4460ca74de3b96` |

The Docling CycloneDX SBOM contains Docling 2.124.0, docling-core 2.92.0,
Transformers 5.16.1, PyTorch 2.13.0+cpu and pypdfium2 5.13.0.

## Secret scan

Earlier candidate scans are not reused for the final commit. Gitleaks 8.30.1 is
run again against the amended committed history, and GitHub Security must repeat
the scan for the final PR head before this increment can be accepted.

## GitHub checks and deployment

The final PR head must match the workflow run API's `headSha`, and that run must
have both `Verify` and `Secrets, image, SBOM and secondary scan` green. The
Security job must show that the two non-blocking document-image scan steps
executed rather than being skipped. Its artifact name uses the workflow's
checked-out `github.sha` (a temporary merge SHA for `pull_request`, not
necessarily the PR head), and the downloaded artifact must contain all six JSON
SBOM files. These fields are pending until the branch is pushed.

No Gitee push, Coolify deployment, public health/version check or real online
upload was performed in this increment.
