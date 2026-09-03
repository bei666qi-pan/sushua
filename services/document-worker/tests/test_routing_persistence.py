from __future__ import annotations

import json
import unittest
from hashlib import sha256

from document_worker.contracts import ParseRequest
from document_worker.parsers import ParsedDocument
from document_worker.service import DocumentProcessingService


class RoutingPersistenceTests(unittest.TestCase):
    def test_document_ir_persists_pdf_page_routing_evidence(self) -> None:
        source = b"verified-pdf-source"
        storage = MemoryStorage(source)
        routing = {
            "mode": "auto",
            "pages": [
                {
                    "pageNumber": 1,
                    "route": "native",
                    "textCharacters": 42,
                    "reason": "sufficient_native_text",
                }
            ],
        }
        service = DocumentProcessingService(
            token="d" * 32,
            storage=storage,
            parsers=[FixtureParser(routing)],
        )

        service.parse(self._request(source))

        output = json.loads(storage.writes[0][1])
        self.assertEqual(output["document"]["routing"], routing)

    @staticmethod
    def _request(source: bytes) -> ParseRequest:
        return ParseRequest.model_validate(
            {
                "schemaVersion": 1,
                "jobId": "019c9e68-62b6-7f58-a10b-7bbd5532e201",
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
                "parseConfig": {"mode": "study_material"},
                "irSchemaVersion": "sushua.document-ir.v1",
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


class FixtureParser:
    def __init__(self, routing: dict[str, object]) -> None:
        self._routing = routing

    def supports(self, mime_type: str) -> bool:
        return mime_type == "application/pdf"

    def parse(self, *_args: object, **_kwargs: object) -> ParsedDocument:
        return ParsedDocument(
            parser="fixture",
            parser_version="1.0.0",
            pages=[
                {
                    "pageNumber": 1,
                    "width": 1,
                    "height": 1,
                    "blocks": [
                        {
                            "blockId": "block-1",
                            "blockType": "text",
                            "text": "source",
                            "markdown": "source",
                            "bbox": [0, 0, 1, 1],
                            "readingOrder": 0,
                            "confidence": 1,
                            "sourceHash": "a" * 64,
                        }
                    ],
                }
            ],
            routing=self._routing,
        )


if __name__ == "__main__":
    unittest.main()
