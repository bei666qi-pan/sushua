from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import pypdfium2 as pdfium  # type: ignore[import-untyped]

from .ocr import OcrAdapterError, OcrResult, to_docling_document

PdfPageRoute = Literal["native", "ocr"]
PdfRoutingMode = Literal["auto", "forced_native", "forced_ocr"]

_MIN_NATIVE_TEXT_CHARACTERS = 24
_PDF_RENDER_SCALE = 2
_MAX_PDF_PAGES = 100
_MAX_RENDERED_PAGE_PIXELS = 40_000_000
_MAX_RENDERED_DOCUMENT_PIXELS = 300_000_000


@dataclass(frozen=True)
class PdfPageDecision:
    page_number: int
    route: PdfPageRoute
    text_characters: int | None
    reason: Literal[
        "sufficient_native_text",
        "insufficient_native_text",
        "manual_native_override",
        "manual_ocr_override",
    ]

    def as_dict(self) -> dict[str, int | str | None]:
        return {
            "pageNumber": self.page_number,
            "route": self.route,
            "textCharacters": self.text_characters,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class PdfRoutingPlan:
    mode: PdfRoutingMode
    pages: tuple[PdfPageDecision, ...]

    @property
    def native_page_numbers(self) -> tuple[int, ...]:
        return tuple(page.page_number for page in self.pages if page.route == "native")

    @property
    def ocr_page_numbers(self) -> tuple[int, ...]:
        return tuple(page.page_number for page in self.pages if page.route == "ocr")

    def as_dict(self) -> dict[str, object]:
        return {"mode": self.mode, "pages": [page.as_dict() for page in self.pages]}


class PdfPageRoutingModule:
    """Choose PDF page routes and retain the evidence behind every choice."""

    def inspect(self, source_path: Path, ocr_setting: bool | None) -> PdfRoutingPlan:
        try:
            document = pdfium.PdfDocument(source_path)
        except (pdfium.PdfiumError, OSError, ValueError) as error:
            raise OcrAdapterError("paddle_invalid_pdf") from error
        try:
            page_count = len(document)
            if page_count < 1:
                raise OcrAdapterError("paddle_invalid_pdf")
            if page_count > _MAX_PDF_PAGES:
                raise OcrAdapterError("paddle_pdf_page_limit_exceeded")

            characters: list[int] = []
            total_pixels = 0
            for index in range(page_count):
                width, height = document.get_page_size(index)
                if not _positive_number(width) or not _positive_number(height):
                    raise OcrAdapterError("paddle_invalid_pdf")
                pixels = math.ceil(width * _PDF_RENDER_SCALE) * math.ceil(
                    height * _PDF_RENDER_SCALE
                )
                if pixels > _MAX_RENDERED_PAGE_PIXELS:
                    raise OcrAdapterError("paddle_pdf_pixel_limit_exceeded")
                total_pixels += pixels
                if total_pixels > _MAX_RENDERED_DOCUMENT_PIXELS:
                    raise OcrAdapterError("paddle_pdf_pixel_limit_exceeded")

                page = document[index]
                text_page = None
                try:
                    text_page = page.get_textpage()
                    text = text_page.get_text_range()
                finally:
                    if text_page is not None:
                        text_page.close()
                    page.close()
                characters.append(sum(1 for character in text if not character.isspace()))
        except OcrAdapterError:
            raise
        except (pdfium.PdfiumError, OSError, ValueError) as error:
            raise OcrAdapterError("paddle_invalid_pdf") from error
        finally:
            document.close()

        if ocr_setting is False:
            mode: PdfRoutingMode = "forced_native"
            decisions = tuple(
                PdfPageDecision(index, "native", count, "manual_native_override")
                for index, count in enumerate(characters, start=1)
            )
        elif ocr_setting is True:
            mode = "forced_ocr"
            decisions = tuple(
                PdfPageDecision(index, "ocr", count, "manual_ocr_override")
                for index, count in enumerate(characters, start=1)
            )
        else:
            mode = "auto"
            decisions = tuple(
                PdfPageDecision(
                    index,
                    "native" if count >= _MIN_NATIVE_TEXT_CHARACTERS else "ocr",
                    count,
                    (
                        "sufficient_native_text"
                        if count >= _MIN_NATIVE_TEXT_CHARACTERS
                        else "insufficient_native_text"
                    ),
                )
                for index, count in enumerate(characters, start=1)
            )
        return PdfRoutingPlan(mode=mode, pages=decisions)

    def forced_ocr(self, result: OcrResult) -> PdfRoutingPlan:
        if not result.pages:
            raise OcrAdapterError("paddle_output_invalid")
        return PdfRoutingPlan(
            mode="forced_ocr",
            pages=tuple(
                PdfPageDecision(
                    page.page_number,
                    "ocr",
                    None,
                    "manual_ocr_override",
                )
                for page in result.pages
            ),
        )


def merge_pdf_content(
    native: dict[str, object] | None,
    ocr: OcrResult | None,
    plan: PdfRoutingPlan,
) -> dict[str, object]:
    if native is None:
        if ocr is None:
            raise ValueError("pdf_routing_result_missing")
        return to_docling_document(ocr, expected_page_numbers=plan.ocr_page_numbers)
    if ocr is None:
        return native

    ocr_content = to_docling_document(ocr, expected_page_numbers=plan.ocr_page_numbers)
    native_pages = native.get("pages")
    native_texts = native.get("texts")
    ocr_pages = ocr_content.get("pages")
    ocr_texts = ocr_content.get("texts")
    if (
        not isinstance(native_pages, dict)
        or not isinstance(native_texts, list)
        or not isinstance(ocr_pages, dict)
        or not isinstance(ocr_texts, list)
    ):
        raise ValueError("pdf_routing_native_output_invalid")

    ocr_page_set = set(plan.ocr_page_numbers)
    merged_pages = dict(native_pages)
    merged_pages.update(ocr_pages)
    merged_texts = [
        item
        for item in native_texts
        if _text_page_number(item) not in ocr_page_set
    ]
    merged_texts.extend(ocr_texts)
    merged_texts.sort(key=_text_page_number)
    return {**native, "pages": merged_pages, "texts": merged_texts}


def _text_page_number(item: object) -> int:
    if not isinstance(item, dict):
        raise ValueError("pdf_routing_native_output_invalid")
    provenance = item.get("prov")
    if not isinstance(provenance, list) or len(provenance) != 1:
        raise ValueError("pdf_routing_native_output_invalid")
    entry = provenance[0]
    if not isinstance(entry, dict):
        raise ValueError("pdf_routing_native_output_invalid")
    page_number = entry.get("page_no")
    if not isinstance(page_number, int) or isinstance(page_number, bool) or page_number < 1:
        raise ValueError("pdf_routing_native_output_invalid")
    return page_number


def _positive_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value > 0
    )
