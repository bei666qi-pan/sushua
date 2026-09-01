# Phase 2j Docling Adapter verification

Date: 2026-09-02

## Scope

- Register the isolated Docling service behind the existing Document Service parser seam.
- Route DOCX to Docling only when its URL and independent service token are fully configured.
- Preserve PlainText precedence and the existing MarkItDown fallback when Docling is absent or the
  MIME type has no verified Docling-to-IR mapping.
- Convert the verified `sushua.docling-output.v1` title/text subset into deterministic
  `sushua.document-ir.v1` pages and blocks without claiming source layout truth.
- Reject dependency failures, protocol tampering, empty results, and unsupported complex structures
  without publishing partial IR.

## TDD evidence

The first real two-service HTTP contract returned `parser: markitdown` instead of `docling`. The
failure located the missing boundary precisely: Document Service did not register the new Adapter
or pass tenant/document/source context through the parser protocol. After that minimal wiring, the
same real DOCX contract returned Docling 2.124.0 output and deterministic IR source hashes.

A second failing contract showed that a Docling 401 was exposed as a user-facing 422. The HTTP
mapping now classifies 401/403 as `docling_service_auth_failed` with 502 and `retryable: false`,
while 408/429/5xx remain retryable dependency failures.

A redirect probe then showed Python's default HTTP opener issued one request to the supplied
`Location`. The Adapter now uses a no-redirect opener, maps all 3xx responses to a protocol error,
and the same probe verifies the redirect target receives zero requests.

The same capture endpoint, configured through `HTTP_PROXY` with an empty `NO_PROXY`, initially
intercepted the internal request. The dedicated opener now installs an empty proxy handler, ignores
process proxy variables for this internal service call, and the capture endpoint remains untouched.

A 206 response carrying an otherwise valid conversion was also accepted and published as a 200 IR
before the final protocol check. The Adapter now accepts exact HTTP 200 only; every other success
status fails as `docling_protocol_error` before response content is trusted.

The complex-structure contract also failed first because the initial converter silently ignored a
non-empty Docling table collection. The Adapter now rejects non-empty table, picture, key-value, or
form collections with `docling_unsupported_structure` until their Document IR mappings exist.

## Covered contracts

- Real DOCX passes through Document Service by object reference into the real Docling service.
- Conversion response size, strict response Schema, bounded object key, SHA256, document identity,
  source reference, parse config, parser metadata, and output content are verified before IR write.
- Missing Docling configuration preserves the real MarkItDown DOCX path; partial or invalid
  configuration fails at startup.
- Authentication, temporary dependency failure, wrong output key, wrong SHA, identity mismatch,
  malformed or oversized response, non-200 success, HTTP redirect/proxy exfiltration, empty output,
  and unsupported structure all fail explicitly. The capture probe confirms neither a supplied
  `Location` nor process proxy variables can trigger a second destination request.
- Failure cases do not create `document-ir.json`; neither service log contains source text or token.
- Docling currently claims only DOCX. PPTX, XLSX, HTML, and simple fallback remain with MarkItDown.

## Fresh verification

- The focused HTTP RED first returned `markitdown` instead of `docling`; the same real DOCX test
  passed after parser registration and context wiring. The dependency-auth RED first returned 422
  instead of 502, then passed after the status mapping correction. The complex-table RED first
  published partial text, then passed after unsupported-structure rejection was added.
- A fresh full `ci:verify` returned exit 0 against the isolated PostgreSQL
  `127.0.0.1:55432/sushua_test`, Redis `127.0.0.1:49448/0`, and real ClamAV
  `127.0.0.1:53655`. It completed 12 Document Service Python tests, all Node unit/golden/real
  integration tests, both constrained container contracts, TypeScript and strict mypy, ESLint and
  Ruff, Next.js 15.5.24 production build, npm audit, and both pip-audit runs. npm reported 0
  vulnerabilities; both Python environments reported no known vulnerabilities. The internal
  `sushua-document-service-core` package is not on PyPI and is therefore listed as skipped, while
  all of its installed third-party dependencies remain in the audited environments.
- The full gate also reproduced three test-infrastructure scheduling limits rather than product
  failures: the constrained Document container and the lightweight Document Service in the
  two-service contract became healthy after their former 20-second readiness windows, and the
  local HTTP fake exceeded a two-second test-only client timeout under sustained load. Readiness
  polling is now bounded at 60 seconds and that test-only client timeout at five seconds; the
  focused contracts and the subsequent full gate both completed successfully.
- The final local images were rebuilt from this worktree as
  `sha256:a261018a41513335d1c0f9d20b32e6e1620140e417fa419fab86ebc8a9512c68`
  (Document Service, UID/GID 10001) and
  `sha256:c2189c4c581c5aa4684002074f4b4df57fb21c35e86a191167ecaa3525960b0c`
  (Docling, UID/GID 10002).
- Trivy 0.74.0 reported 13 HIGH and 3 CRITICAL Debian findings in each image and 0
  HIGH/CRITICAL Python-package findings. Grype 0.118.0 reported 20 HIGH / 7 CRITICAL for Document
  Service and 38 HIGH / 7 CRITICAL for Docling; the additional 18 Docling HIGH matches are binary
  classifications, and Python dependency types contain 0 HIGH/CRITICAL. These are the explicitly
  approved, fully reported document-image base-layer exceptions, not a zero-vulnerability claim.
- Syft 1.51.1 produced and JSON-validated CycloneDX/SPDX SBOMs for both images: Document Service
  1,143,026 / 2,610,559 bytes and Docling 1,537,120 / 3,390,774 bytes.
- Gitleaks 8.30.1 scanned the pre-commit history of 104 commits (about 3.80 MB) with no leaks. An
  additional directory-mode scan found 14 generated-only candidates, all under ignored `.next`
  output: Next preview/server-action build keys and webpack cache content. No candidate was in a
  source or pending commit path. The final committed history is scanned again before PR creation.
- The original user-owned workspace remained at
  `064093a87c95ff470e73d046dab898467082d1ea`; its tracked and untracked change list remained
  unchanged.

## Release boundary

This increment is not deployed and is not mirrored to Gitee. It does not prove a public upload or
parse flow. Production enablement still requires runtime secrets, internal networking, the existing
async-ingestion flags, full release-chain verification, and public endpoint evidence.
