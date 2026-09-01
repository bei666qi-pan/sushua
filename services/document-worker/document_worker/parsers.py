from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class ParsedDocument:
    parser: str
    parser_version: str
    pages: list[dict[str, Any]]


class DocumentParser(Protocol):
    def supports(self, mime_type: str) -> bool: ...

    def parse(self, content: bytes, mime_type: str, source_sha256: str) -> ParsedDocument: ...


class PlainTextParser:
    name = "plain-text"
    version = "1.0.0"
    _mime_types = frozenset({"text/plain", "text/markdown"})

    def supports(self, mime_type: str) -> bool:
        return mime_type in self._mime_types

    def parse(self, content: bytes, mime_type: str, source_sha256: str) -> ParsedDocument:
        if not self.supports(mime_type):
            raise ValueError("unsupported_media_type")
        try:
            text = content.decode("utf-8").rstrip()
        except UnicodeDecodeError as error:
            raise ValueError("invalid_document_content") from error
        if not text:
            raise ValueError("invalid_document_content")
        bbox = [0, 0, 1, 1]
        source_hash = _sha256_text(
            f"{self.version}\n{text}\n{','.join(str(value) for value in bbox)}\n{source_sha256}"
        )
        return ParsedDocument(
            parser=self.name,
            parser_version=self.version,
            pages=[
                {
                    "pageNumber": 1,
                    "width": 1,
                    "height": 1,
                    "blocks": [
                        {
                            "blockId": "block-1",
                            "blockType": "text",
                            "text": text,
                            "markdown": text,
                            "bbox": bbox,
                            "readingOrder": 0,
                            "confidence": 1,
                            "sourceHash": source_hash,
                        }
                    ],
                }
            ],
        )


def _sha256_text(value: str) -> str:
    from hashlib import sha256

    return sha256(value.encode("utf-8")).hexdigest()
