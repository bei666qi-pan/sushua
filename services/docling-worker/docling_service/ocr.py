from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol


@dataclass(frozen=True)
class OcrBlock:
    text: str
    label: Literal["text", "paragraph", "section_header", "unknown"]
    bbox: tuple[float, float, float, float]
    confidence: float
    heading_level: int | None = None


@dataclass(frozen=True)
class OcrPage:
    page_number: int
    width: float
    height: float
    blocks: tuple[OcrBlock, ...]


@dataclass(frozen=True)
class OcrResult:
    pages: tuple[OcrPage, ...]


class OcrAdapter(Protocol):
    def recognize(self, source_path: Path, mime_type: str) -> OcrResult: ...


class OcrAdapterError(Exception):
    def __init__(self, code: str, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


class OcrOutputError(ValueError):
    pass


def to_docling_document(result: OcrResult) -> dict[str, object]:
    if not result.pages:
        raise OcrOutputError("ocr_output_empty")
    pages: dict[str, object] = {}
    texts: list[dict[str, object]] = []
    expected_page_number = 1
    for page in result.pages:
        if (
            isinstance(page.page_number, bool)
            or page.page_number != expected_page_number
            or not _positive_finite(page.width)
            or not _positive_finite(page.height)
        ):
            raise OcrOutputError("ocr_output_invalid")
        if not page.blocks:
            raise OcrOutputError("ocr_output_empty")
        pages[str(page.page_number)] = {
            "page_no": page.page_number,
            "size": {"width": page.width, "height": page.height},
        }
        for block in page.blocks:
            _validate_block(block, page)
            item: dict[str, object] = {
                "text": block.text,
                "label": block.label,
                "confidence": block.confidence,
                "prov": [
                    {
                        "page_no": page.page_number,
                        "charspan": [0, len(block.text)],
                        "bbox": {
                            "l": block.bbox[0],
                            "t": block.bbox[1],
                            "r": block.bbox[2],
                            "b": block.bbox[3],
                            "coord_origin": "TOPLEFT",
                        },
                    }
                ],
            }
            if block.heading_level is not None:
                item["level"] = block.heading_level
            texts.append(item)
        expected_page_number += 1
    return {
        "schema_name": "DoclingDocument",
        "pages": pages,
        "texts": texts,
        "tables": [],
        "pictures": [],
        "key_value_items": [],
        "form_items": [],
    }


def _validate_block(block: OcrBlock, page: OcrPage) -> None:
    left, top, right, bottom = block.bbox
    if (
        not block.text.strip()
        or not all(_finite_number(value) for value in block.bbox)
        or not 0 <= left < right <= page.width
        or not 0 <= top < bottom <= page.height
        or not _finite_number(block.confidence)
        or not 0 <= block.confidence <= 1
        or (
            block.label == "section_header"
            and (
                block.heading_level is None
                or isinstance(block.heading_level, bool)
                or not 1 <= block.heading_level <= 6
            )
        )
        or (block.label != "section_header" and block.heading_level is not None)
    ):
        raise OcrOutputError("ocr_output_invalid")


def _positive_finite(value: float) -> bool:
    return _finite_number(value) and value > 0


def _finite_number(value: float) -> bool:
    return not isinstance(value, bool) and math.isfinite(value)
