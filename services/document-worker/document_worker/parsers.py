from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Any, Protocol
from zipfile import BadZipFile, ZipFile

from markitdown import MarkItDown


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


class MarkItDownParser:
    name = "markitdown"
    version = "0.1.7"
    _mime_type_extensions = {
        "text/html": ".html",
        "application/xhtml+xml": ".html",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    }
    _office_package_markers = {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (
            "word/document.xml"
        ),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": (
            "ppt/presentation.xml"
        ),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xl/workbook.xml",
    }
    _max_archive_entries = 4096
    _max_archive_uncompressed_bytes = 256 * 1024 * 1024
    _max_member_uncompressed_bytes = 128 * 1024 * 1024
    _max_compression_ratio = 200

    def __init__(self) -> None:
        self._converter = MarkItDown(enable_plugins=False)

    def supports(self, mime_type: str) -> bool:
        return mime_type in self._mime_type_extensions

    def parse(self, content: bytes, mime_type: str, source_sha256: str) -> ParsedDocument:
        extension = self._mime_type_extensions.get(mime_type)
        if extension is None:
            raise ValueError("unsupported_media_type")
        if not content:
            raise ValueError("invalid_document_content")
        self._validate_office_package(content, mime_type)
        try:
            result = self._converter.convert_stream(
                BytesIO(content),
                file_extension=extension,
            )
        except Exception as error:
            raise ValueError("invalid_document_content") from error
        markdown = result.markdown.strip()
        if not markdown:
            raise ValueError("invalid_document_content")
        bbox = [0, 0, 1, 1]
        source_hash = _sha256_text(
            f"{self.version}\n{markdown}\n{','.join(str(value) for value in bbox)}\n{source_sha256}"
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
                            "text": markdown,
                            "markdown": markdown,
                            "bbox": bbox,
                            "readingOrder": 0,
                            "confidence": 0.8,
                            "sourceHash": source_hash,
                        }
                    ],
                }
            ],
        )

    def _validate_office_package(self, content: bytes, mime_type: str) -> None:
        required_member = self._office_package_markers.get(mime_type)
        if required_member is None:
            return
        try:
            with ZipFile(BytesIO(content)) as archive:
                members = archive.infolist()
                if required_member not in {member.filename for member in members}:
                    raise ValueError("invalid_document_content")
                expanded_bytes = 0
                if len(members) > self._max_archive_entries:
                    raise ValueError("document_archive_budget_exceeded")
                for member in members:
                    expanded_bytes += member.file_size
                    if (
                        member.file_size > self._max_member_uncompressed_bytes
                        or expanded_bytes > self._max_archive_uncompressed_bytes
                        or (
                            member.file_size > 0
                            and (
                                member.compress_size == 0
                                or member.file_size / member.compress_size
                                > self._max_compression_ratio
                            )
                        )
                    ):
                        raise ValueError("document_archive_budget_exceeded")
        except BadZipFile as error:
            raise ValueError("invalid_document_content") from error


def _sha256_text(value: str) -> str:
    from hashlib import sha256

    return sha256(value.encode("utf-8")).hexdigest()
