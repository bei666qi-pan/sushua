from __future__ import annotations

import json
import unittest
from hashlib import sha256
from pathlib import Path

from docling.datamodel.base_models import ConversionStatus

from docling_service.contracts import ConvertRequest
from docling_service.ocr import OcrBlock, OcrPage, OcrResult
from docling_service.service import DoclingConversionService, DoclingServiceError


class PdfPageRoutingTests(unittest.TestCase):
    def test_auto_mode_keeps_all_searchable_pages_native(self) -> None:
        texts = [
            "First native page contains enough searchable material for routing.",
            "Second native page also contains enough searchable material for routing.",
        ]
        source = pdf_with_pages(texts)
        storage = MemoryStorage(source)
        ocr = SelectiveOcrAdapter()
        service = self._service(storage, ocr, texts)

        service.convert(self._request(source, parse_config={"mode": "study_material"}))

        self.assertEqual(ocr.observed_page_numbers, [])
        output = json.loads(storage.writes[0][1])
        self.assertEqual(
            [page["route"] for page in output["document"]["routing"]["pages"]],
            ["native", "native"],
        )

    def test_auto_mode_keeps_native_pages_and_ocrs_only_blank_pages(self) -> None:
        native_text = "Native study material has enough searchable text for this first page."
        source = pdf_with_pages([native_text, ""])
        storage = MemoryStorage(source)
        ocr = SelectiveOcrAdapter()
        service = self._service(storage, ocr, [native_text, ""])

        service.convert(self._request(source, parse_config={"mode": "study_material"}))

        self.assertEqual(ocr.observed_page_numbers, [(2,)])
        output = json.loads(storage.writes[0][1])
        self.assertEqual(
            output["document"]["routing"],
            {
                "mode": "auto",
                "pages": [
                    {
                        "pageNumber": 1,
                        "route": "native",
                        "textCharacters": 59,
                        "reason": "sufficient_native_text",
                    },
                    {
                        "pageNumber": 2,
                        "route": "ocr",
                        "textCharacters": 0,
                        "reason": "insufficient_native_text",
                    },
                ],
            },
        )
        self.assertEqual(
            [item["text"] for item in output["document"]["content"]["texts"]],
            [native_text, "OCR page 2"],
        )

    def test_auto_mode_routes_a_scanned_pdf_to_ocr_page_by_page(self) -> None:
        source = pdf_with_pages(["", ""])
        storage = MemoryStorage(source)
        ocr = SelectiveOcrAdapter()
        service = self._service(storage, ocr, ["", ""])

        service.convert(self._request(source, parse_config={"mode": "study_material"}))

        self.assertEqual(ocr.observed_page_numbers, [(1, 2)])
        output = json.loads(storage.writes[0][1])
        self.assertEqual(
            [page["route"] for page in output["document"]["routing"]["pages"]],
            ["ocr", "ocr"],
        )

    def test_explicit_false_forces_native_pages_without_calling_ocr(self) -> None:
        source = pdf_with_pages([""])
        storage = MemoryStorage(source)
        ocr = SelectiveOcrAdapter()
        service = self._service(storage, ocr, [""])

        service.convert(
            self._request(
                source,
                parse_config={"mode": "study_material", "ocr": False},
            )
        )

        self.assertEqual(ocr.observed_page_numbers, [])
        output = json.loads(storage.writes[0][1])
        self.assertEqual(output["document"]["routing"]["mode"], "forced_native")
        self.assertEqual(output["document"]["routing"]["pages"][0]["route"], "native")

    def test_explicit_true_forces_all_pages_through_ocr(self) -> None:
        source = pdf_with_pages(["Native text remains ignored in forced OCR mode.", ""])
        storage = MemoryStorage(source)
        ocr = SelectiveOcrAdapter()
        service = self._service(storage, ocr, ["unused", "unused"])

        service.convert(
            self._request(
                source,
                parse_config={"mode": "study_material", "ocr": True},
            )
        )

        self.assertEqual(ocr.observed_page_numbers, [(1, 2)])
        output = json.loads(storage.writes[0][1])
        self.assertEqual(output["document"]["routing"]["mode"], "forced_ocr")
        self.assertEqual(
            [page["route"] for page in output["document"]["routing"]["pages"]],
            ["ocr", "ocr"],
        )
        self.assertEqual(
            [
                page["textCharacters"]
                for page in output["document"]["routing"]["pages"]
            ],
            [None, None],
        )

    def test_auto_mode_fails_clearly_when_a_low_text_page_needs_missing_ocr(self) -> None:
        source = pdf_with_pages([""])
        storage = MemoryStorage(source)
        service = self._service(storage, None, [""])

        with self.assertRaises(DoclingServiceError) as raised:
            service.convert(self._request(source, parse_config={"mode": "study_material"}))

        self.assertEqual(raised.exception.code, "ocr_pipeline_unavailable")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(storage.writes, [])

    def test_auto_mode_rejects_page_budget_before_docling_or_ocr_inference(self) -> None:
        source = pdf_with_pages([""] * 101)
        storage = MemoryStorage(source)
        ocr = SelectiveOcrAdapter()
        service = self._service(storage, ocr, [""] * 101)
        converter = service._pdf_converter

        with self.assertRaises(DoclingServiceError) as raised:
            service.convert(self._request(source, parse_config={"mode": "study_material"}))

        self.assertEqual(raised.exception.code, "ocr_page_limit_exceeded")
        self.assertEqual(getattr(converter, "calls", -1), 0)
        self.assertEqual(ocr.observed_page_numbers, [])
        self.assertEqual(storage.writes, [])

    @staticmethod
    def _service(
        storage: MemoryStorage,
        ocr: SelectiveOcrAdapter | None,
        native_texts: list[str],
    ) -> DoclingConversionService:
        service = DoclingConversionService(token="d" * 32, storage=storage, ocr=ocr)
        service._pdf_converter = NativeConverter(native_texts)
        return service

    @staticmethod
    def _request(source: bytes, *, parse_config: dict[str, object]) -> ConvertRequest:
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
                    "mimeType": "application/pdf",
                },
                "parseConfig": parse_config,
                "outputSchemaVersion": "sushua.docling-output.v1",
            }
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


class NativeConverter:
    def __init__(self, texts: list[str]) -> None:
        self._texts = texts
        self.calls = 0

    def convert(self, _source_path: object) -> NativeResult:
        self.calls += 1
        return NativeResult(self._texts)


class NativeResult:
    status = ConversionStatus.SUCCESS
    errors: list[object] = []

    def __init__(self, texts: list[str]) -> None:
        self.document = NativeDocument(texts)


class NativeDocument:
    def __init__(self, texts: list[str]) -> None:
        self._texts = texts

    def export_to_dict(self) -> dict[str, object]:
        pages = {
            str(index): {
                "page_no": index,
                "size": {"width": 612, "height": 792},
            }
            for index in range(1, len(self._texts) + 1)
        }
        texts = []
        for index, text in enumerate(self._texts, start=1):
            if text:
                texts.append(
                    {
                        "text": text,
                        "label": "text",
                        "prov": [
                            {
                                "page_no": index,
                                "charspan": [0, len(text)],
                                "bbox": {
                                    "l": 72,
                                    "t": 720,
                                    "r": 540,
                                    "b": 690,
                                    "coord_origin": "BOTTOMLEFT",
                                },
                            }
                        ],
                    }
                )
        return {
            "schema_name": "DoclingDocument",
            "pages": pages,
            "texts": texts,
            "tables": [],
            "pictures": [],
            "key_value_items": [],
            "form_items": [],
        }


class SelectiveOcrAdapter:
    def __init__(self) -> None:
        self.observed_page_numbers: list[tuple[int, ...]] = []

    def supports(self, mime_type: str) -> bool:
        return mime_type == "application/pdf"

    def recognize(
        self,
        _source_path: Path,
        _mime_type: str,
        page_numbers: tuple[int, ...] | None = None,
    ) -> OcrResult:
        selected = page_numbers or (1, 2)
        self.observed_page_numbers.append(selected)
        return OcrResult(
            pages=tuple(
                OcrPage(
                    page_number=page_number,
                    width=1224,
                    height=1584,
                    blocks=(
                        OcrBlock(
                            text=f"OCR page {page_number}",
                            label="unknown",
                            bbox=(100, 100, 900, 180),
                            confidence=0.97,
                        ),
                    ),
                )
                for page_number in selected
            )
        )


def pdf_with_pages(texts: list[str]) -> bytes:
    objects: list[bytes] = []
    page_object_numbers = [3 + index * 2 for index in range(len(texts))]
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{number} 0 R" for number in page_object_numbers)
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(texts)} >>".encode())
    font_object_number = 3 + len(texts) * 2
    for index, text in enumerate(texts):
        page_number = page_object_numbers[index]
        content_number = page_number + 1
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 {font_object_number} 0 R >> >> "
                f"/Contents {content_number} 0 R >>"
            ).encode()
        )
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode() if text else b""
        objects.append(
            b"<< /Length "
            + str(len(stream)).encode()
            + b" >>\nstream\n"
            + stream
            + b"\nendstream"
        )
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    body = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, value in enumerate(objects, start=1):
        offsets.append(len(body))
        body.extend(f"{number} 0 obj\n".encode())
        body.extend(value)
        body.extend(b"\nendobj\n")
    xref = len(body)
    body.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    body.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        body.extend(f"{offset:010d} 00000 n \n".encode())
    body.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n"
        ).encode()
    )
    return bytes(body)


if __name__ == "__main__":
    unittest.main()
