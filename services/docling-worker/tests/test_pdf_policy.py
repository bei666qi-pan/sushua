from __future__ import annotations

import unittest
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
from docling.datamodel.base_models import ConversionStatus, InputFormat

from docling_service.contracts import ConvertRequest
from docling_service.service import (
    DoclingConversionService,
    DoclingServiceError,
    _pdf_converter,
)


class PdfPolicyTests(unittest.TestCase):
    def test_configured_model_path_must_validate_before_service_is_ready(self) -> None:
        service = DoclingConversionService(
            token="d" * 32,
            storage=UnreadStorage(),
            artifacts_path="/missing/sushua-docling-models",
        )

        self.assertFalse(service.ready())

    def test_native_pdf_converter_uses_offline_pdfium_backend(self) -> None:
        converter = _pdf_converter(Path("/tmp/sushua-docling-models"))
        option = converter.format_to_options[InputFormat.PDF]

        self.assertIs(option.backend, PyPdfiumDocumentBackend)
        self.assertIsNotNone(option.backend_options)
        assert option.backend_options is not None
        self.assertFalse(option.backend_options.enable_remote_fetch)
        self.assertFalse(option.backend_options.enable_local_fetch)
        self.assertFalse(option.pipeline_options.do_ocr)
        self.assertFalse(option.pipeline_options.do_table_structure)
        self.assertFalse(option.pipeline_options.enable_remote_services)
        self.assertFalse(option.pipeline_options.allow_external_plugins)

    def test_partial_docling_result_is_not_written_as_success(self) -> None:
        source = b"docling-converter-test-boundary"
        storage = MemoryStorage(source)
        request = self._request()
        request = request.model_copy(
            update={
                "source": request.source.model_copy(
                    update={
                        "mime_type": (
                            "application/vnd.openxmlformats-officedocument."
                            "wordprocessingml.document"
                        ),
                        "size_bytes": len(source),
                        "sha256": sha256(source).hexdigest(),
                    }
                )
            }
        )

        with patch("docling_service.service.DocumentConverter", return_value=PartialConverter()):
            service = DoclingConversionService(token="d" * 32, storage=storage)

        with self.assertRaises(DoclingServiceError) as raised:
            service.convert(request)

        self.assertEqual(raised.exception.code, "document_conversion_partial")
        self.assertEqual(raised.exception.status_code, 422)
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(storage.writes, [])

    def test_failed_docling_result_is_not_written_as_success(self) -> None:
        source = b"docling-converter-test-boundary"
        storage = MemoryStorage(source)
        request = self._request()
        request = request.model_copy(
            update={
                "source": request.source.model_copy(
                    update={
                        "mime_type": (
                            "application/vnd.openxmlformats-officedocument."
                            "wordprocessingml.document"
                        ),
                        "size_bytes": len(source),
                        "sha256": sha256(source).hexdigest(),
                    }
                )
            }
        )

        with patch(
            "docling_service.service.DocumentConverter",
            return_value=FailedConverter(),
        ):
            service = DoclingConversionService(token="d" * 32, storage=storage)

        with self.assertRaises(DoclingServiceError) as raised:
            service.convert(request)

        self.assertEqual(raised.exception.code, "document_conversion_failed")
        self.assertEqual(raised.exception.status_code, 422)
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(storage.writes, [])

    def test_pdf_without_prebaked_artifacts_fails_before_reading_source(self) -> None:
        storage = UnreadStorage()
        service = DoclingConversionService(
            token="d" * 32,
            storage=storage,
        )
        request = self._request()

        with self.assertRaises(DoclingServiceError) as raised:
            service.convert(request)

        self.assertEqual(raised.exception.code, "pdf_models_unavailable")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(storage.read_count, 0)

    def test_pdf_ocr_request_without_engine_fails_before_reading_source(self) -> None:
        storage = UnreadStorage()
        service = DoclingConversionService(token="d" * 32, storage=storage)
        request = self._request().model_copy(
            update={"parse_config": {"mode": "study_material", "ocr": True}}
        )

        with self.assertRaises(DoclingServiceError) as raised:
            service.convert(request)

        self.assertEqual(raised.exception.code, "ocr_pipeline_unavailable")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(storage.read_count, 0)

    def test_pdf_without_an_explicit_ocr_setting_uses_the_native_path(self) -> None:
        storage = UnreadStorage()
        service = DoclingConversionService(token="d" * 32, storage=storage)
        request = self._request().model_copy(
            update={"parse_config": {"mode": "study_material"}}
        )

        with self.assertRaises(DoclingServiceError) as raised:
            service.convert(request)

        self.assertEqual(raised.exception.code, "pdf_models_unavailable")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(storage.read_count, 0)

    def test_pdf_rejects_a_non_boolean_ocr_setting_before_reading_source(self) -> None:
        storage = UnreadStorage()
        service = DoclingConversionService(token="d" * 32, storage=storage)
        request = self._request().model_copy(
            update={"parse_config": {"mode": "study_material", "ocr": "true"}}
        )

        with self.assertRaises(DoclingServiceError) as raised:
            service.convert(request)

        self.assertEqual(raised.exception.code, "invalid_parse_config")
        self.assertEqual(raised.exception.status_code, 422)
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(storage.read_count, 0)

    @staticmethod
    def _request() -> ConvertRequest:
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
                    "sha256": "a" * 64,
                    "sizeBytes": 1024,
                    "mimeType": "application/pdf",
                },
                "parseConfig": {"mode": "study_material", "ocr": False},
                "outputSchemaVersion": "sushua.docling-output.v1",
            }
        )


class UnreadStorage:
    def __init__(self) -> None:
        self.read_count = 0

    def read(self, _object_key: str) -> bytes:
        self.read_count += 1
        raise FileNotFoundError

    def write(self, _object_key: str, _content: bytes) -> None:
        raise AssertionError("conversion output must not be written")

    def ready(self) -> bool:
        return True


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


class PartialConverter:
    def convert(self, _source_path: object) -> PartialResult:
        return PartialResult()


class ConvertedDocument:
    def export_to_dict(self) -> dict[str, object]:
        return {"texts": [], "pages": {}}


class PartialResult:
    status = ConversionStatus.PARTIAL_SUCCESS
    errors = []
    document = ConvertedDocument()


class FailedConverter:
    def convert(self, _source_path: object) -> FailedResult:
        return FailedResult()


class FailedResult:
    status = ConversionStatus.FAILURE
    errors = []
    document = ConvertedDocument()


if __name__ == "__main__":
    unittest.main()
