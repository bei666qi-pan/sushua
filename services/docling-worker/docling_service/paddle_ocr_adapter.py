from __future__ import annotations

import math
from collections.abc import Mapping
from pathlib import Path
from typing import Any, TypeGuard

from PIL import Image

from .ocr import OcrAdapterError, OcrBlock, OcrPage, OcrResult
from .paddle_model_artifacts import validated_paddle_artifacts_path

_IMAGE_MIME_TYPES = frozenset({"image/jpeg", "image/png"})


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
    return PaddleOcrAdapter(artifacts_path)


class PaddleOcrAdapter:
    def __init__(self, artifacts_path: Path) -> None:
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

    def recognize(self, source_path: Path, mime_type: str) -> OcrResult:
        if mime_type not in _IMAGE_MIME_TYPES:
            raise OcrAdapterError("paddle_unsupported_media_type")
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
        return OcrResult(
            pages=(
                paddle_prediction_to_page(
                    prediction,
                    page_number=1,
                    width=width,
                    height=height,
                ),
            )
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
