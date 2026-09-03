# Phase 2o OCR contract verification

## Scope

This increment introduces the internal OCR seam inside the isolated Docling
image without advertising OCR as an available product capability.

- Scanned PDF, JPEG and PNG share one `OcrAdapter` interface.
- The adapter receives only the integrity-checked temporary source path and
  MIME type. It does not receive object-storage credentials or business
  database access.
- OCR output must contain consecutive pages, source dimensions, non-empty
  blocks, top-left pixel bounding boxes and confidence in the range 0-1.
- Unknown and low-confidence content is retained. Empty pages, invalid boxes
  and invalid confidence fail before a conversion object is written.
- The Document Service converts OCR provenance to normalized top-left
  `[x, y, width, height]` IR coordinates and preserves OCR confidence.
- Safe OCR failure codes survive the Docling-to-Document Service hop. Internal
  adapter details are replaced with `ocr_failed`.

## Explicitly not delivered

PaddleOCR/PaddlePaddle, model artifacts, OpenCV preprocessing, image upload
routing and the production OCR feature flag are not wired in this increment.
The running Docling service therefore returns `ocr_pipeline_unavailable` for
OCR requests and the Document Service does not claim JPEG/PNG support. A fake
or fixture adapter is used only to exercise the interface and storage effects;
it is not evidence that PaddleOCR works.

MarkItDown remains the lightweight Office/HTML fallback. Docling remains in
its independent Python Debian slim image. Trivy and Grype continue to report
the complete image result; Python application dependency high/critical
findings remain blocking while OS-layer image findings remain non-blocking.

## TDD evidence

The first targeted run failed because `docling_service.ocr` did not exist and
the old PDF branch returned `ocr_required`. After the minimal implementation,
the OCR service contract and PDF policy tests passed.

A second failing test proved that image OCR was being treated as a one-page
logical Office document and confidence was replaced with `0.85`. The converter
now uses page provenance for JPEG/PNG and preserves the validated OCR value.

A third failing test proved that arbitrary internal adapter error text could
escape. The service now emits only `ocr_failed`, with retryability preserved;
the real two-service HTTP contract verifies the safe code mapping.

## Release boundary

This is a contract and validation increment. It must not be described as
working OCR, scanned-PDF support, phone-photo support, or completion of Phase
2. The next OCR increment must add a pinned CPU PaddleOCR adapter, pre-baked and
hashed model artifacts, OpenCV preprocessing, a real licensed Golden image and
container-level recognition evidence before enabling routing.
