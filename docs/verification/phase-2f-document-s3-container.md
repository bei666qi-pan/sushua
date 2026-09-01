# Phase 2f: Document Service S3 and container boundary

## Scope

- Add a boto3 S3-compatible `StorageAdapter` selected by `STORAGE_DRIVER=s3`.
- Validate endpoint, region, bucket and explicit credentials before client creation.
- Translate SDK failures into the existing bounded service error contract.
- Build a Python 3.11 image with a frozen base and uv image digest.
- Run as numeric UID/GID 10001 without dev dependencies or build tooling.
- Generate and scan a dedicated Document Service SBOM/image in CI.

Docling, MarkItDown, OCR, PDF/Office parsing and production deployment remain outside this increment.

## Causal evidence

The S3 contract starts Moto as an isolated HTTP service, creates a private bucket through the Node
AWS SDK, uploads the source object using the same tenant key as upload v1, starts the real FastAPI
service, and invokes it through the existing Node `DocumentServiceClient`. The test then reads the
IR back from S3 and independently checks its SHA256.

The container contract builds the actual Document Service image, verifies a numeric non-root image
user, and runs it with a read-only root filesystem, all Linux capabilities dropped,
`no-new-privileges`, and a bounded no-exec tmpfs. A source object is parsed and the resulting IR is
verified outside the container; captured logs are checked for source text and tokens.

Moto proves the signed HTTP Adapter contract, not external provider availability. The container
test proves the app can operate under the selected runtime restrictions, not that Coolify currently
applies them.
