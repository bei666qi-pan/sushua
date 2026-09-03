from __future__ import annotations

import json
import unittest

from sushua_document_service.contracts import SourceReference

from document_worker.docling_adapter import (
    DOCX_MIME,
    DoclingAdapterError,
    adapter_from_environment,
    convert_output,
)
from document_worker.parsers import ParserContext


class DoclingAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = SourceReference.model_validate(
            {
                "assetId": "019c9e68-62b6-7f58-a10b-7bbd5532e105",
                "objectKey": (
                    "tenant/019c9e68-62b6-7f58-a10b-7bbd5532e102/"
                    "019c9e68-62b6-7f58-a10b-7bbd5532e103/"
                    "019c9e68-62b6-7f58-a10b-7bbd5532e104/source/"
                    "019c9e68-62b6-7f58-a10b-7bbd5532e105"
                ),
                "sha256": "a" * 64,
                "sizeBytes": 1024,
                "mimeType": (
                    "application/vnd.openxmlformats-officedocument."
                    "wordprocessingml.document"
                ),
            }
        )
        self.context = ParserContext(
            trace_id="019c9e68-62b6-7f58-a10b-7bbd5532e101",
            workspace_id="019c9e68-62b6-7f58-a10b-7bbd5532e102",
            document_id="019c9e68-62b6-7f58-a10b-7bbd5532e103",
            document_version_id="019c9e68-62b6-7f58-a10b-7bbd5532e104",
            source=self.source,
            parse_config={"mode": "study_material", "ocr": False},
        )

    def test_rejects_unconverted_tables_instead_of_publishing_partial_ir(self) -> None:
        output = self._output(
            content={
                "schema_name": "DoclingDocument",
                "texts": [{"text": "Visible paragraph", "label": "text"}],
                "tables": [{"data": {"table_cells": [{"text": "Hidden answer"}]}}],
            }
        )

        with self.assertRaisesRegex(DoclingAdapterError, "docling_unsupported_structure"):
            convert_output(
                output,
                context=self.context,
                source_sha256=self.source.sha256,
                parser_version="2.124.0",
            )

    def test_absent_configuration_preserves_local_parser_fallback(self) -> None:
        self.assertIsNone(adapter_from_environment({}, UnusedStorage()))

    def test_partial_or_invalid_configuration_fails_closed(self) -> None:
        invalid_configurations = [
            ({"DOCLING_SERVICE_URL": "http://docling.internal"}, "incomplete"),
            ({"DOCLING_SERVICE_TOKEN": "d" * 32}, "incomplete"),
            (
                {
                    "DOCLING_SERVICE_URL": "file:///tmp/docling",
                    "DOCLING_SERVICE_TOKEN": "d" * 32,
                },
                "invalid_docling_service_url",
            ),
            (
                {
                    "DOCLING_SERVICE_URL": "http://docling.internal",
                    "DOCLING_SERVICE_TOKEN": "short",
                },
                "invalid_docling_service_token",
            ),
            (
                {
                    "DOCLING_SERVICE_URL": "http://docling.internal",
                    "DOCLING_SERVICE_TOKEN": "d" * 32,
                    "DOCLING_SERVICE_TIMEOUT_SECONDS": "0",
                },
                "invalid_docling_service_timeout",
            ),
        ]
        for environment, expected_error in invalid_configurations:
            with (
                self.subTest(environment=environment),
                self.assertRaisesRegex(RuntimeError, expected_error),
            ):
                adapter_from_environment(environment, UnusedStorage())

    def test_configured_adapter_keeps_native_pdf_disabled_by_default(self) -> None:
        adapter = adapter_from_environment(
            {
                "DOCLING_SERVICE_URL": "http://docling.internal",
                "DOCLING_SERVICE_TOKEN": "d" * 32,
            },
            UnusedStorage(),
        )

        self.assertIsNotNone(adapter)
        assert adapter is not None
        self.assertTrue(adapter.supports(DOCX_MIME))
        self.assertFalse(adapter.supports("application/pdf"))
        self.assertFalse(
            adapter.supports(
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            )
        )

    def test_explicit_capability_flag_enables_native_pdf_only(self) -> None:
        adapter = adapter_from_environment(
            {
                "DOCLING_SERVICE_URL": "http://docling.internal",
                "DOCLING_SERVICE_TOKEN": "d" * 32,
                "DOCLING_NATIVE_PDF_ENABLED": "true",
            },
            UnusedStorage(),
        )

        self.assertIsNotNone(adapter)
        assert adapter is not None
        self.assertTrue(adapter.supports(DOCX_MIME))
        self.assertTrue(adapter.supports("application/pdf"))
        self.assertFalse(
            adapter.supports(
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            )
        )

    def test_explicit_ocr_image_flag_enables_jpeg_and_png_only(self) -> None:
        adapter = adapter_from_environment(
            {
                "DOCLING_SERVICE_URL": "http://docling.internal",
                "DOCLING_SERVICE_TOKEN": "d" * 32,
                "DOCLING_OCR_IMAGE_ENABLED": "true",
            },
            UnusedStorage(),
        )

        self.assertIsNotNone(adapter)
        assert adapter is not None
        self.assertTrue(adapter.supports(DOCX_MIME))
        self.assertTrue(adapter.supports("image/jpeg"))
        self.assertTrue(adapter.supports("image/png"))
        self.assertFalse(adapter.supports("application/pdf"))

    def test_explicit_ocr_pdf_flag_enables_pdf_without_enabling_images(self) -> None:
        adapter = adapter_from_environment(
            {
                "DOCLING_SERVICE_URL": "http://docling.internal",
                "DOCLING_SERVICE_TOKEN": "d" * 32,
                "DOCLING_OCR_PDF_ENABLED": "true",
            },
            UnusedStorage(),
        )

        self.assertIsNotNone(adapter)
        assert adapter is not None
        self.assertTrue(adapter.supports(DOCX_MIME))
        self.assertTrue(adapter.supports("application/pdf"))
        self.assertFalse(adapter.supports("image/jpeg"))
        self.assertFalse(adapter.supports("image/png"))

    def test_pdf_capability_flags_cannot_borrow_each_others_parse_mode(self) -> None:
        base_environment = {
            "DOCLING_SERVICE_URL": "http://docling.internal",
            "DOCLING_SERVICE_TOKEN": "d" * 32,
        }
        native_only = adapter_from_environment(
            {**base_environment, "DOCLING_NATIVE_PDF_ENABLED": "true"},
            UnusedStorage(),
        )
        ocr_only = adapter_from_environment(
            {**base_environment, "DOCLING_OCR_PDF_ENABLED": "true"},
            UnusedStorage(),
        )
        assert native_only is not None
        assert ocr_only is not None
        native_context = self._pdf_context()
        ocr_context = ParserContext(
            trace_id=native_context.trace_id,
            workspace_id=native_context.workspace_id,
            document_id=native_context.document_id,
            document_version_id=native_context.document_version_id,
            source=native_context.source,
            parse_config={"mode": "study_material", "ocr": True},
        )

        with self.assertRaisesRegex(
            DoclingAdapterError,
            "ocr_pipeline_unavailable",
        ):
            native_only.parse(b"", "application/pdf", "a" * 64, ocr_context)
        with self.assertRaisesRegex(
            DoclingAdapterError,
            "pdf_models_unavailable",
        ):
            ocr_only.parse(b"", "application/pdf", "a" * 64, native_context)

        auto_context = ParserContext(
            trace_id=self.context.trace_id,
            workspace_id=self.context.workspace_id,
            document_id=self.context.document_id,
            document_version_id=self.context.document_version_id,
            source=native_context.source,
            parse_config={"mode": "study_material"},
        )
        with self.assertRaisesRegex(
            DoclingAdapterError,
            "ocr_pipeline_unavailable",
        ):
            native_only.parse(b"", "application/pdf", "a" * 64, auto_context)

    def test_pdf_rejects_an_invalid_ocr_mode_before_calling_docling(self) -> None:
        adapter = adapter_from_environment(
            {
                "DOCLING_SERVICE_URL": "http://docling.internal",
                "DOCLING_SERVICE_TOKEN": "d" * 32,
                "DOCLING_NATIVE_PDF_ENABLED": "true",
                "DOCLING_OCR_PDF_ENABLED": "true",
            },
            UnusedStorage(),
        )
        assert adapter is not None
        context = self._pdf_context()
        invalid_context = ParserContext(
            trace_id=context.trace_id,
            workspace_id=context.workspace_id,
            document_id=context.document_id,
            document_version_id=context.document_version_id,
            source=context.source,
            parse_config={"mode": "study_material", "ocr": "true"},
        )

        with self.assertRaisesRegex(DoclingAdapterError, "invalid_parse_config"):
            adapter.parse(b"", "application/pdf", "a" * 64, invalid_context)

    def test_converts_native_pdf_pages_and_bottom_left_provenance(self) -> None:
        context = self._pdf_context()
        pdf_source = context.source
        output = self._output(
            context=context,
            content={
                "schema_name": "DoclingDocument",
                "pages": {
                    "1": {"page_no": 1, "size": {"width": 200, "height": 400}},
                    "2": {"page_no": 2, "size": {"width": 100, "height": 100}},
                },
                "texts": [
                    {
                        "text": "Cell membrane",
                        "label": "section_header",
                        "level": 1,
                        "prov": [
                            {
                                "page_no": 1,
                                "charspan": [0, 13],
                                "bbox": {
                                    "l": 20,
                                    "t": 380,
                                    "r": 180,
                                    "b": 340,
                                    "coord_origin": "BOTTOMLEFT",
                                },
                            }
                        ],
                    },
                    {
                        "text": "Mitochondria produce ATP.",
                        "label": "text",
                        "prov": [
                            {
                                "page_no": 2,
                                "charspan": [0, 25],
                                "bbox": {
                                    "l": 10,
                                    "t": 90,
                                    "r": 90,
                                    "b": 50,
                                    "coord_origin": "BOTTOMLEFT",
                                },
                            }
                        ],
                    },
                ],
            },
        )

        parsed = convert_output(
            output,
            context=context,
            source_sha256=pdf_source.sha256,
            parser_version="2.124.0",
        )

        self.assertEqual(
            parsed.pages,
            [
                {
                    "pageNumber": 1,
                    "width": 200,
                    "height": 400,
                    "blocks": [
                        {
                            "blockId": "block-1",
                            "blockType": "heading",
                            "text": "Cell membrane",
                            "markdown": "# Cell membrane",
                            "bbox": [0.1, 0.05, 0.8, 0.1],
                            "readingOrder": 0,
                            "confidence": 0.85,
                            "sourceHash": (
                                "3ad5f6cbfe814cb58894c573adab7ab519125315b8e5b9d0a2288970a794f453"
                            ),
                            "headingLevel": 1,
                        }
                    ],
                },
                {
                    "pageNumber": 2,
                    "width": 100,
                    "height": 100,
                    "blocks": [
                        {
                            "blockId": "block-2",
                            "blockType": "text",
                            "text": "Mitochondria produce ATP.",
                            "markdown": "Mitochondria produce ATP.",
                            "bbox": [0.1, 0.1, 0.8, 0.4],
                            "readingOrder": 0,
                            "confidence": 0.85,
                            "sourceHash": (
                                "469b43f60da821840fdd0bb51106a91b898fe0662914e77299d0c5b5bb064399"
                            ),
                        }
                    ],
                },
            ],
        )

    def test_pdf_text_requires_provenance(self) -> None:
        with self.assertRaisesRegex(DoclingAdapterError, "docling_invalid_provenance"):
            self._convert_pdf_text(provenance=[])

    def test_pdf_provenance_must_reference_a_declared_page(self) -> None:
        with self.assertRaisesRegex(DoclingAdapterError, "docling_invalid_provenance"):
            self._convert_pdf_text(
                provenance=[self._provenance(page_number=2, left=10, top=90, right=90, bottom=50)]
            )

    def test_pdf_provenance_cannot_span_pages(self) -> None:
        with self.assertRaisesRegex(DoclingAdapterError, "docling_invalid_provenance"):
            self._convert_pdf_text(
                provenance=[
                    self._provenance(page_number=1, left=10, top=90, right=40, bottom=70),
                    self._provenance(page_number=2, left=10, top=90, right=40, bottom=70),
                ],
                page_count=2,
            )

    def test_pdf_provenance_bbox_must_stay_inside_the_page(self) -> None:
        with self.assertRaisesRegex(DoclingAdapterError, "docling_invalid_provenance"):
            self._convert_pdf_text(
                provenance=[
                    self._provenance(page_number=1, left=-1, top=90, right=90, bottom=50)
                ]
            )

    def test_pdf_provenance_cannot_merge_disjoint_same_page_regions(self) -> None:
        with self.assertRaisesRegex(DoclingAdapterError, "docling_invalid_provenance"):
            self._convert_pdf_text(
                provenance=[
                    self._provenance(page_number=1, left=10, top=90, right=40, bottom=70),
                    self._provenance(page_number=1, left=35, top=75, right=90, bottom=50),
                ]
            )

    def test_pdf_provenance_must_cover_the_complete_text(self) -> None:
        provenance = self._provenance(
            page_number=1,
            left=10,
            top=90,
            right=90,
            bottom=50,
        )
        provenance["charspan"] = [0, 7]

        with self.assertRaisesRegex(DoclingAdapterError, "docling_invalid_provenance"):
            self._convert_pdf_text(provenance=[provenance])

    def test_native_pdf_does_not_publish_a_page_without_locatable_text(self) -> None:
        with self.assertRaisesRegex(DoclingAdapterError, "ocr_required"):
            self._convert_pdf_text(
                provenance=[
                    self._provenance(
                        page_number=1,
                        left=10,
                        top=90,
                        right=90,
                        bottom=50,
                    )
                ],
                page_count=2,
            )

    def test_pdf_routing_evidence_is_preserved_for_document_ir(self) -> None:
        context = self._pdf_context()
        routing = {
            "mode": "auto",
            "pages": [
                {
                    "pageNumber": 1,
                    "route": "native",
                    "textCharacters": 17,
                    "reason": "sufficient_native_text",
                }
            ],
        }
        output = json.loads(
            self._output(
                context=context,
                content={
                    "schema_name": "DoclingDocument",
                    "pages": {
                        "1": {
                            "page_no": 1,
                            "size": {"width": 100, "height": 100},
                        }
                    },
                    "texts": [
                        {
                            "text": "Visible paragraph",
                            "label": "text",
                            "prov": [
                                self._provenance(
                                    page_number=1,
                                    left=10,
                                    top=90,
                                    right=90,
                                    bottom=50,
                                )
                            ],
                        }
                    ],
                },
            )
        )
        output["document"]["routing"] = routing

        parsed = convert_output(
            json.dumps(output).encode(),
            context=context,
            source_sha256=context.source.sha256,
            parser_version="2.124.0",
        )

        self.assertEqual(getattr(parsed, "routing", None), routing)

        output["document"]["routing"]["pages"][0]["reason"] = "manual_native_override"
        with self.assertRaisesRegex(DoclingAdapterError, "docling_protocol_error"):
            convert_output(
                json.dumps(output).encode(),
                context=context,
                source_sha256=context.source.sha256,
                parser_version="2.124.0",
            )

    def test_unmapped_pdf_label_is_preserved_as_unknown_instead_of_text(self) -> None:
        parsed = self._convert_pdf_text(
            provenance=[
                self._provenance(
                    page_number=1,
                    left=10,
                    top=90,
                    right=90,
                    bottom=50,
                )
            ],
            label="formula",
        )

        self.assertEqual(parsed.pages[0]["blocks"][0]["blockType"], "unknown")
        self.assertEqual(parsed.pages[0]["blocks"][0]["text"], "Visible paragraph")

    def test_ocr_image_preserves_normalized_bbox_and_low_confidence(self) -> None:
        image_source = self.source.model_copy(update={"mime_type": "image/png"})
        context = ParserContext(
            trace_id=self.context.trace_id,
            workspace_id=self.context.workspace_id,
            document_id=self.context.document_id,
            document_version_id=self.context.document_version_id,
            source=image_source,
            parse_config={"mode": "study_material", "ocr": True},
        )

        parsed = convert_output(
            self._output(
                context=context,
                content={
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
                },
            ),
            context=context,
            source_sha256=context.source.sha256,
            parser_version="2.124.0",
        )

        self.assertEqual(
            parsed.pages,
            [
                {
                    "pageNumber": 1,
                    "width": 1200,
                    "height": 1600,
                    "blocks": [
                        {
                            "blockId": "block-1",
                            "blockType": "unknown",
                            "text": "一、细胞膜的主要成分是？",
                            "markdown": "一、细胞膜的主要成分是？",
                            "bbox": [0.1, 0.1, 0.8, 0.1],
                            "readingOrder": 0,
                            "confidence": 0.42,
                            "sourceHash": (
                                "76c2752d63c43374ec7235b19ee046e263cd9a150fc787de95199e8558658eed"
                            ),
                        }
                    ],
                }
            ],
        )

    def test_section_heading_level_cannot_be_silently_clamped(self) -> None:
        with self.assertRaisesRegex(DoclingAdapterError, "docling_unsupported_structure"):
            self._convert_pdf_text(
                provenance=[
                    self._provenance(
                        page_number=1,
                        left=10,
                        top=90,
                        right=90,
                        bottom=50,
                    )
                ],
                label="section_header",
                level=9,
            )

    def test_rejects_mismatched_conversion_identity(self) -> None:
        output = json.loads(self._output(content=self._text_content()))
        output["document"]["workspaceId"] = "019c9e68-62b6-7f58-a10b-7bbd5532efff"

        with self.assertRaisesRegex(DoclingAdapterError, "docling_protocol_error"):
            convert_output(
                json.dumps(output).encode(),
                context=self.context,
                source_sha256=self.source.sha256,
                parser_version="2.124.0",
            )

    def test_rejects_empty_conversion_instead_of_publishing_empty_ir(self) -> None:
        with self.assertRaisesRegex(DoclingAdapterError, "docling_output_empty"):
            convert_output(
                self._output(
                    content={
                        "schema_name": "DoclingDocument",
                        "texts": [{"text": "   ", "label": "text"}],
                    }
                ),
                context=self.context,
                source_sha256=self.source.sha256,
                parser_version="2.124.0",
            )

    @staticmethod
    def _text_content() -> dict[str, object]:
        return {
            "schema_name": "DoclingDocument",
            "texts": [{"text": "Visible paragraph", "label": "text"}],
        }

    def _output(
        self,
        *,
        content: dict[str, object],
        context: ParserContext | None = None,
    ) -> bytes:
        actual_context = context or self.context
        return json.dumps(
            {
                "schemaVersion": "sushua.docling-output.v1",
                "document": {
                    "id": actual_context.document_id,
                    "workspaceId": actual_context.workspace_id,
                    "documentVersionId": actual_context.document_version_id,
                    "source": actual_context.source.model_dump(by_alias=True),
                    "parseConfig": actual_context.parse_config,
                    "parser": {"name": "docling", "version": "2.124.0"},
                    "content": content,
                },
            },
            separators=(",", ":"),
        ).encode()

    def _pdf_context(self) -> ParserContext:
        pdf_source = self.source.model_copy(update={"mime_type": "application/pdf"})
        return ParserContext(
            trace_id=self.context.trace_id,
            workspace_id=self.context.workspace_id,
            document_id=self.context.document_id,
            document_version_id=self.context.document_version_id,
            source=pdf_source,
            parse_config=self.context.parse_config,
        )

    def _convert_pdf_text(
        self,
        *,
        provenance: list[dict[str, object]],
        page_count: int = 1,
        label: str = "text",
        level: int | None = None,
    ):
        context = self._pdf_context()
        pages = {
            str(page_number): {
                "page_no": page_number,
                "size": {"width": 100, "height": 100},
            }
            for page_number in range(1, page_count + 1)
        }
        return convert_output(
            self._output(
                context=context,
                content={
                    "schema_name": "DoclingDocument",
                    "pages": pages,
                    "texts": [
                        {
                            "text": "Visible paragraph",
                            "label": label,
                            **({"level": level} if level is not None else {}),
                            "prov": provenance,
                        }
                    ],
                },
            ),
            context=context,
            source_sha256=context.source.sha256,
            parser_version="2.124.0",
        )

    @staticmethod
    def _provenance(
        *,
        page_number: int,
        left: int,
        top: int,
        right: int,
        bottom: int,
    ) -> dict[str, object]:
        return {
            "page_no": page_number,
            "charspan": [0, 17],
            "bbox": {
                "l": left,
                "t": top,
                "r": right,
                "b": bottom,
                "coord_origin": "BOTTOMLEFT",
            },
        }


class UnusedStorage:
    def read(self, _object_key: str) -> bytes:
        raise AssertionError("storage must not be read while validating configuration")

    def write(self, _object_key: str, _content: bytes) -> None:
        raise AssertionError("storage must not be written while validating configuration")

    def ready(self) -> bool:
        return True


if __name__ == "__main__":
    unittest.main()
