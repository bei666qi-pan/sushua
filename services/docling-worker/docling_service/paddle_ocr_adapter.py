from __future__ import annotations

import math
from collections.abc import Mapping
from pathlib import Path
from typing import Any, TypeGuard

import pypdfium2 as pdfium  # type: ignore[import-untyped]
from PIL import Image

from .ocr import OcrAdapterError, OcrBlock, OcrPage, OcrResult
from .paddle_model_artifacts import validated_paddle_artifacts_path

_IMAGE_MIME_TYPES = frozenset({"image/jpeg", "image/png"})
_PDF_MIME_TYPE = "application/pdf"
_PDF_RENDER_SCALE = 2
_MAX_PDF_PAGES = 100
_MAX_RENDERED_PAGE_PIXELS = 40_000_000
_MAX_RENDERED_DOCUMENT_PIXELS = 300_000_000


def paddle_adapter_from_environment(
    environment: Mapping[str, str],
) -> PaddleOcrAdapter | None:
    if not _enabled(environment.get("PADDLE_OCR_ENABLED")):
        return None
    artifacts_path = validated_paddle_artifacts_path(
        environment.get("PADDLE_OCR_ARTIFACTS_PATH")
    )
    if artifacts_path is None:
        raise RuntimeError("invalid_paddle_ocr_artifacts")
    return PaddleOcrAdapter(
        artifacts_path,
        pdf_enabled=_enabled(environment.get("PADDLE_OCR_PDF_ENABLED")),
    )


class PaddleOcrAdapter:
    def __init__(self, artifacts_path: Path, *, pdf_enabled: bool = False) -> None:
        from paddleocr import PaddleOCR  # type: ignore[import-not-found,import-untyped]

        self._engine: Any = PaddleOCR(
            text_detection_model_name="PP-OCRv5_mobile_det",
            text_detection_model_dir=str(
                artifacts_path / "PP-OCRv5_mobile_det_infer"
            ),
            text_recognition_model_name="PP-OCRv5_mobile_rec",
            text_recognition_model_dir=str(
                artifacts_path / "PP-OCRv5_mobile_rec_infer"
            ),
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            device="cpu",
            enable_mkldnn=False,
        )
        self._pdf_enabled = pdf_enabled

    def supports(self, mime_type: str) -> bool:
        return mime_type in _IMAGE_MIME_TYPES or (
            mime_type == _PDF_MIME_TYPE and self._pdf_enabled
        )

    def recognize(
        self,
        source_path: Path,
        mime_type: str,
        page_numbers: tuple[int, ...] | None = None,
    ) -> OcrResult:
        if not self.supports(mime_type):
            raise OcrAdapterError("paddle_unsupported_media_type")
        if mime_type == _PDF_MIME_TYPE:
            return self._recognize_pdf(source_path, page_numbers=page_numbers)
        if page_numbers is not None:
            raise OcrAdapterError("paddle_unsupported_media_type")
        return OcrResult(pages=(self._recognize_image(source_path, page_number=1),))

    def _recognize_pdf(
        self,
        source_path: Path,
        *,
        page_numbers: tuple[int, ...] | None,
    ) -> OcrResult:
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
            page_sizes = [document.get_page_size(index) for index in range(page_count)]
            total_pixels = 0
            for width, height in page_sizes:
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

            selected = page_numbers or tuple(range(1, page_count + 1))
            if (
                not selected
                or tuple(sorted(set(selected))) != selected
                or selected[0] < 1
                or selected[-1] > page_count
            ):
                raise OcrAdapterError("paddle_invalid_pdf")
            pages: list[OcrPage] = []
            for page_number in selected:
                index = page_number - 1
                page = document[index]
                bitmap = None
                try:
                    bitmap = page.render(scale=_PDF_RENDER_SCALE, may_draw_forms=False)
                    rendered = bitmap.to_pil()
                    rendered_path = source_path.parent / f"ocr-page-{page_number}.png"
                    rendered.save(rendered_path, format="PNG")
                    pages.append(
                        self._recognize_image(rendered_path, page_number=page_number)
                    )
                finally:
                    if bitmap is not None:
                        bitmap.close()
                    page.close()
            return OcrResult(pages=tuple(pages))
        except OcrAdapterError:
            raise
        except (pdfium.PdfiumError, OSError, ValueError) as error:
            raise OcrAdapterError("paddle_invalid_pdf") from error
        finally:
            document.close()

    def _recognize_image(self, source_path: Path, *, page_number: int) -> OcrPage:
        try:
            with Image.open(source_path) as image:
                width, height = image.size
                image.verify()
        except (OSError, ValueError) as error:
            raise OcrAdapterError("paddle_invalid_image") from error
        try:
            predictions = self._engine.predict(str(source_path))
        except Exception as error:
            raise OcrAdapterError("paddle_inference_failed", retryable=True) from error
        if not isinstance(predictions, list) or len(predictions) != 1:
            raise OcrAdapterError("paddle_output_invalid")
        result_json = getattr(predictions[0], "json", None)
        if not isinstance(result_json, Mapping):
            raise OcrAdapterError("paddle_output_invalid")
        prediction = result_json.get("res")
        if not isinstance(prediction, Mapping):
            raise OcrAdapterError("paddle_output_invalid")
        return paddle_prediction_to_page(
            prediction,
            page_number=page_number,
            width=width,
            height=height,
        )


def paddle_prediction_to_page(
    prediction: Mapping[str, object],
    *,
    page_number: int,
    width: float,
    height: float,
) -> OcrPage:
    texts = prediction.get("rec_texts")
    scores = prediction.get("rec_scores")
    polygons = prediction.get("rec_polys")
    boxes = prediction.get("rec_boxes")
    if (
        prediction.get("page_index") is not None
        or
        not isinstance(texts, list)
        or not isinstance(scores, list)
        or not isinstance(polygons, list)
        or not isinstance(boxes, list)
        or len(texts) != len(scores)
        or len(texts) != len(polygons)
        or len(texts) != len(boxes)
    ):
        raise OcrAdapterError("paddle_output_invalid")
    blocks: list[OcrBlock] = []
    for text, score, polygon, box in zip(texts, scores, polygons, boxes, strict=True):
        if (
            not isinstance(text, str)
            or not text.strip()
            or not _confidence(score)
            or not _box(box, width=width, height=height)
            or not _polygon_matches_box(polygon, box)
        ):
            raise OcrAdapterError("paddle_output_invalid")
        blocks.append(
            OcrBlock(
                text=text,
                label="unknown",
                bbox=(box[0], box[1], box[2], box[3]),
                confidence=score,
            )
        )
    return OcrPage(
        page_number=page_number,
        width=width,
        height=height,
        blocks=tuple(blocks),
    )


def _confidence(value: object) -> bool:
    if not _number(value):
        return False
    return 0 <= value <= 1


def _box(value: object, *, width: float, height: float) -> bool:
    if not isinstance(value, list) or len(value) != 4:
        return False
    left, top, right, bottom = value
    if not (
        _number(left)
        and _number(top)
        and _number(right)
        and _number(bottom)
    ):
        return False
    return 0 <= left < right <= width and 0 <= top < bottom <= height


def _number(value: object) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _positive_number(value: object) -> TypeGuard[int | float]:
    return _number(value) and value > 0


def _polygon_matches_box(polygon: object, box: object) -> bool:
    if (
        not isinstance(polygon, list)
        or len(polygon) < 4
        or not isinstance(box, list)
        or len(box) != 4
    ):
        return False
    points: list[tuple[int | float, int | float]] = []
    for point in polygon:
        if (
            not isinstance(point, list)
            or len(point) != 2
            or not _number(point[0])
            or not _number(point[1])
        ):
            return False
        points.append((point[0], point[1]))
    left, top, right, bottom = box
    if not (
        _number(left)
        and _number(top)
        and _number(right)
        and _number(bottom)
    ):
        return False
    return (
        min(point[0] for point in points) == left
        and min(point[1] for point in points) == top
        and max(point[0] for point in points) == right
        and max(point[1] for point in points) == bottom
    )


def _enabled(value: str | None) -> bool:
    return value is not None and value.strip().lower() in {"1", "true", "yes", "on"}
