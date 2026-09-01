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

    def test_configured_adapter_only_claims_docx_until_other_ir_mappings_exist(self) -> None:
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

    def _output(self, *, content: dict[str, object]) -> bytes:
        return json.dumps(
            {
                "schemaVersion": "sushua.docling-output.v1",
                "document": {
                    "id": self.context.document_id,
                    "workspaceId": self.context.workspace_id,
                    "documentVersionId": self.context.document_version_id,
                    "source": self.source.model_dump(by_alias=True),
                    "parseConfig": self.context.parse_config,
                    "parser": {"name": "docling", "version": "2.124.0"},
                    "content": content,
                },
            },
            separators=(",", ":"),
        ).encode()


class UnusedStorage:
    def read(self, _object_key: str) -> bytes:
        raise AssertionError("storage must not be read while validating configuration")

    def write(self, _object_key: str, _content: bytes) -> None:
        raise AssertionError("storage must not be written while validating configuration")

    def ready(self) -> bool:
        return True


if __name__ == "__main__":
    unittest.main()
