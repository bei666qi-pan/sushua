from __future__ import annotations

import json
import unittest
from hashlib import sha256
from pathlib import Path

from docling_service.contracts import ConvertRequest
from docling_service.ocr import OcrAdapterError, OcrBlock, OcrPage, OcrResult
from docling_service.service import DoclingConversionService, DoclingServiceError


class OcrContractTests(unittest.TestCase):
    def test_scanned_pdf_preserves_page_bbox_confidence_and_unknown_content(self) -> None:
        source = b"scanned-pdf-fixture"
        storage = MemoryStorage(source)
        service = DoclingConversionService(
            token="d" * 32,
            storage=storage,
            ocr=FixtureOcrAdapter(),
        )

        response = service.convert(self._request(source, "application/pdf"))

        self.assertEqual(response.result.parser, "docling")
        self.assertEqual(len(storage.writes), 1)
        output = json.loads(storage.writes[0][1])
        self.assertEqual(
            output["document"]["content"],
            {
                "schema_name": "DoclingDocument",
                "pages": {
                    "1": {"page_no": 1, "size": {"width": 1200, "height": 1600}}
                },
                "texts": [
                    {
                        "text": "一、细胞膜的主要成分是？",
                        "label": "unknown",
                        "confidence": 0.42,
                        "prov": [
                            {
                                "page_no": 1,
                                "charspan": [0, 12],
                                "bbox": {
                                    "l": 120,
                                    "t": 160,
                                    "r": 1080,
                                    "b": 320,
                                    "coord_origin": "TOPLEFT",
                                },
                            }
                        ],
                    }
                ],
                "tables": [],
                "pictures": [],
                "key_value_items": [],
                "form_items": [],
            },
        )

    def test_png_uses_the_same_ocr_contract(self) -> None:
        source = b"png-fixture"
        storage = MemoryStorage(source)
        ocr = FixtureOcrAdapter()
        service = DoclingConversionService(token="d" * 32, storage=storage, ocr=ocr)

        service.convert(self._request(source, "image/png"))

        self.assertEqual(ocr.observed_mime_types, ["image/png"])
        self.assertEqual(len(storage.writes), 1)

    def test_empty_ocr_page_is_not_written_as_success(self) -> None:
        source = b"empty-scan"
        storage = MemoryStorage(source)
        service = DoclingConversionService(
            token="d" * 32,
            storage=storage,
            ocr=EmptyOcrAdapter(),
        )

        with self.assertRaises(DoclingServiceError) as raised:
            service.convert(self._request(source, "image/jpeg"))

        self.assertEqual(raised.exception.code, "ocr_output_empty")
        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(storage.writes, [])

    def test_invalid_ocr_bbox_is_not_written_as_success(self) -> None:
        source = b"invalid-bbox"
        storage = MemoryStorage(source)
        service = DoclingConversionService(
            token="d" * 32,
            storage=storage,
            ocr=InvalidBboxOcrAdapter(),
        )

        with self.assertRaises(DoclingServiceError) as raised:
            service.convert(self._request(source, "image/png"))

        self.assertEqual(raised.exception.code, "ocr_output_invalid")
        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(storage.writes, [])

    def test_boolean_ocr_confidence_is_not_written_as_success(self) -> None:
        source = b"boolean-confidence"
        storage = MemoryStorage(source)
        service = DoclingConversionService(
            token="d" * 32,
            storage=storage,
            ocr=BooleanConfidenceOcrAdapter(),
        )

        with self.assertRaises(DoclingServiceError) as raised:
            service.convert(self._request(source, "image/png"))

        self.assertEqual(raised.exception.code, "ocr_output_invalid")
        self.assertEqual(storage.writes, [])

    def test_ocr_adapter_internal_error_code_is_not_exposed(self) -> None:
        source = b"adapter-failure"
        storage = MemoryStorage(source)
        service = DoclingConversionService(
            token="d" * 32,
            storage=storage,
            ocr=FailingOcrAdapter(),
        )

        with self.assertRaises(DoclingServiceError) as raised:
            service.convert(self._request(source, "image/png"))

        self.assertEqual(raised.exception.code, "ocr_failed")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertTrue(raised.exception.retryable)
        self.assertEqual(storage.writes, [])

    @staticmethod
    def _request(source: bytes, mime_type: str) -> ConvertRequest:
        return ConvertRequest.model_validate(
            {
                "schemaVersion": 1,
                "traceId": "019c9e68-62b6-7f58-a10b-7bbd5532e201",
                "workspaceId": "019c9e68-62b6-7f58-a10b-7bbd5532e202",
                "documentId": "019c9e68-62b6-7f58-a10b-7bbd5532e203",
                "documentVersionId": "019c9e68-62b6-7f58-a10b-7bbd5532e204",
                "source": {
                    "assetId": "019c9e68-62b6-7f58-a10b-7bbd5532e205",
                    "objectKey": (
                        "tenant/019c9e68-62b6-7f58-a10b-7bbd5532e202/"
                        "019c9e68-62b6-7f58-a10b-7bbd5532e203/"
                        "019c9e68-62b6-7f58-a10b-7bbd5532e204/source/"
                        "019c9e68-62b6-7f58-a10b-7bbd5532e205"
                    ),
                    "sha256": sha256(source).hexdigest(),
                    "sizeBytes": len(source),
                    "mimeType": mime_type,
                },
                "parseConfig": {"mode": "study_material", "ocr": True},
                "outputSchemaVersion": "sushua.docling-output.v1",
            }
        )


class FixtureOcrAdapter:
    def __init__(self) -> None:
        self.observed_mime_types: list[str] = []

    def recognize(self, source_path: Path, mime_type: str) -> OcrResult:
        self.observed_mime_types.append(mime_type)
        self.assert_source_exists(source_path)
        return OcrResult(
            pages=(
                OcrPage(
                    page_number=1,
                    width=1200,
                    height=1600,
                    blocks=(
                        OcrBlock(
                            text="一、细胞膜的主要成分是？",
                            label="unknown",
                            bbox=(120, 160, 1080, 320),
                            confidence=0.42,
                        ),
                    ),
                ),
            )
        )

    @staticmethod
    def assert_source_exists(source_path: Path) -> None:
        if not source_path.is_file():
            raise AssertionError("OCR must receive the verified temporary source")


class EmptyOcrAdapter:
    def recognize(self, _source_path: Path, _mime_type: str) -> OcrResult:
        return OcrResult(
            pages=(OcrPage(page_number=1, width=100, height=100, blocks=()),)
        )


class InvalidBboxOcrAdapter:
    def recognize(self, _source_path: Path, _mime_type: str) -> OcrResult:
        return OcrResult(
            pages=(
                OcrPage(
                    page_number=1,
                    width=100,
                    height=100,
                    blocks=(
                        OcrBlock(
                            text="outside",
                            label="text",
                            bbox=(10, 10, 101, 30),
                            confidence=0.9,
                        ),
                    ),
                ),
            )
        )


class FailingOcrAdapter:
    def recognize(self, _source_path: Path, _mime_type: str) -> OcrResult:
        raise OcrAdapterError("/private/model/cache/token", retryable=True)


class BooleanConfidenceOcrAdapter:
    def recognize(self, _source_path: Path, _mime_type: str) -> OcrResult:
        return OcrResult(
            pages=(
                OcrPage(
                    page_number=1,
                    width=100,
                    height=100,
                    blocks=(
                        OcrBlock(
                            text="boolean",
                            label="text",
                            bbox=(10, 10, 90, 30),
                            confidence=True,
                        ),
                    ),
                ),
            )
        )


class MemoryStorage:
    def __init__(self, source: bytes) -> None:
        self.source = source
        self.writes: list[tuple[str, bytes]] = []

    def read(self, _object_key: str) -> bytes:
        return self.source

    def write(self, object_key: str, content: bytes) -> None:
        self.writes.append((object_key, content))

    def ready(self) -> bool:
        return True


if __name__ == "__main__":
    unittest.main()
