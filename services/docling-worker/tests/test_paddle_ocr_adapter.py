from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import pypdfium2 as pdfium
from PIL import Image

from docling_service.ocr import OcrAdapterError, OcrBlock, OcrPage
from docling_service.paddle_ocr_adapter import (
    PaddleOcrAdapter,
    paddle_adapter_from_environment,
    paddle_prediction_to_page,
)


class PaddleOcrAdapterTests(unittest.TestCase):
    def test_environment_fails_closed_when_ocr_is_enabled_without_valid_models(self) -> None:
        self.assertIsNone(paddle_adapter_from_environment({}))

        with self.assertRaisesRegex(RuntimeError, "invalid_paddle_ocr_artifacts"):
            paddle_adapter_from_environment(
                {
                    "PADDLE_OCR_ENABLED": "true",
                    "PADDLE_OCR_ARTIFACTS_PATH": "/missing/paddle-models",
                }
            )

    def test_environment_requires_a_separate_pdf_capability_flag(self) -> None:
        prediction = valid_prediction("page one")
        fake_module = SimpleNamespace(PaddleOCR=StrictPaddleFactory(prediction))
        with (
            TemporaryDirectory() as directory,
            patch.dict("sys.modules", {"paddleocr": fake_module}),
            patch(
                "docling_service.paddle_ocr_adapter.validated_paddle_artifacts_path",
                return_value=Path(directory),
            ),
        ):
            image_only = paddle_adapter_from_environment(
                {
                    "PADDLE_OCR_ENABLED": "true",
                    "PADDLE_OCR_ARTIFACTS_PATH": directory,
                }
            )
            pdf_enabled = paddle_adapter_from_environment(
                {
                    "PADDLE_OCR_ENABLED": "true",
                    "PADDLE_OCR_PDF_ENABLED": "true",
                    "PADDLE_OCR_ARTIFACTS_PATH": directory,
                }
            )

        self.assertIsNotNone(image_only)
        self.assertIsNotNone(pdf_enabled)
        assert image_only is not None
        assert pdf_enabled is not None
        self.assertFalse(image_only.supports("application/pdf"))
        self.assertTrue(pdf_enabled.supports("application/pdf"))

    def test_adapter_reads_png_dimensions_and_returns_the_prediction(self) -> None:
        prediction: dict[str, object] = {
            "page_index": None,
            "rec_texts": ["细胞膜"],
            "rec_scores": [0.97],
            "rec_polys": [[[10, 20], [190, 20], [190, 60], [10, 60]]],
            "rec_boxes": [[10, 20, 190, 60]],
        }
        fake_module = SimpleNamespace(PaddleOCR=StrictPaddleFactory(prediction))
        with TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (200, 100), "white").save(source)
            with patch.dict("sys.modules", {"paddleocr": fake_module}):
                adapter = PaddleOcrAdapter(Path(directory))
                result = adapter.recognize(source, "image/png")

        self.assertEqual(
            result.pages,
            (
                OcrPage(
                    page_number=1,
                    width=200,
                    height=100,
                    blocks=(
                        OcrBlock(
                            text="细胞膜",
                            label="unknown",
                            bbox=(10, 20, 190, 60),
                            confidence=0.97,
                        ),
                    ),
                ),
            ),
        )

    def test_pdf_support_is_disabled_unless_the_adapter_capability_is_explicit(self) -> None:
        prediction = valid_prediction("page one")
        fake_module = SimpleNamespace(PaddleOCR=StrictPaddleFactory(prediction))
        with (
            TemporaryDirectory() as directory,
            patch.dict("sys.modules", {"paddleocr": fake_module}),
        ):
            adapter = PaddleOcrAdapter(Path(directory))

        self.assertTrue(adapter.supports("image/jpeg"))
        self.assertTrue(adapter.supports("image/png"))
        self.assertFalse(adapter.supports("application/pdf"))

    def test_adapter_renders_a_scanned_pdf_and_preserves_page_order(self) -> None:
        predictions = [
            valid_prediction("first page", box=[10, 20, 190, 60]),
            valid_prediction("second page", box=[20, 30, 180, 90]),
        ]
        engine = SequencePaddleEngine(predictions)
        with TemporaryDirectory() as directory:
            source = Path(directory) / "source.pdf"
            first = Image.new("RGB", (200, 100), "white")
            second = Image.new("RGB", (100, 200), "white")
            first.save(
                source,
                format="PDF",
                save_all=True,
                append_images=[second],
                resolution=72,
            )
            adapter = object.__new__(PaddleOcrAdapter)
            adapter._engine = engine
            adapter._pdf_enabled = True

            result = adapter.recognize(source, "application/pdf")

        self.assertEqual(engine.rendered_sizes, [(400, 200), (200, 400)])
        self.assertEqual(
            result.pages,
            (
                OcrPage(
                    page_number=1,
                    width=400,
                    height=200,
                    blocks=(
                        OcrBlock(
                            text="first page",
                            label="unknown",
                            bbox=(10, 20, 190, 60),
                            confidence=0.97,
                        ),
                    ),
                ),
                OcrPage(
                    page_number=2,
                    width=200,
                    height=400,
                    blocks=(
                        OcrBlock(
                            text="second page",
                            label="unknown",
                            bbox=(20, 30, 180, 90),
                            confidence=0.97,
                        ),
                    ),
                ),
            ),
        )

    def test_adapter_rejects_a_malformed_pdf_without_calling_paddle(self) -> None:
        engine = SequencePaddleEngine([valid_prediction("unused")])
        with TemporaryDirectory() as directory:
            source = Path(directory) / "source.pdf"
            source.write_bytes(b"not-a-pdf")
            adapter = object.__new__(PaddleOcrAdapter)
            adapter._engine = engine
            adapter._pdf_enabled = True

            with self.assertRaises(OcrAdapterError) as raised:
                adapter.recognize(source, "application/pdf")

        self.assertEqual(raised.exception.code, "paddle_invalid_pdf")
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(engine.rendered_sizes, [])

    def test_adapter_rejects_a_pdf_over_the_page_budget_before_rendering(self) -> None:
        engine = SequencePaddleEngine([valid_prediction("unused")])
        with TemporaryDirectory() as directory:
            source = Path(directory) / "source.pdf"
            page = Image.new("RGB", (1, 1), "white")
            page.save(
                source,
                format="PDF",
                save_all=True,
                append_images=[page] * 100,
                resolution=72,
            )
            adapter = object.__new__(PaddleOcrAdapter)
            adapter._engine = engine
            adapter._pdf_enabled = True

            with self.assertRaises(OcrAdapterError) as raised:
                adapter.recognize(source, "application/pdf")

        self.assertEqual(raised.exception.code, "paddle_pdf_page_limit_exceeded")
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(engine.rendered_sizes, [])

    def test_adapter_rejects_a_pdf_over_the_per_page_pixel_budget(self) -> None:
        engine = SequencePaddleEngine([valid_prediction("unused")])
        with TemporaryDirectory() as directory:
            source = Path(directory) / "source.pdf"
            write_blank_pdf(source, [(5_000, 5_000)])
            adapter = object.__new__(PaddleOcrAdapter)
            adapter._engine = engine
            adapter._pdf_enabled = True

            with self.assertRaises(OcrAdapterError) as raised:
                adapter.recognize(source, "application/pdf")

        self.assertEqual(raised.exception.code, "paddle_pdf_pixel_limit_exceeded")
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(engine.rendered_sizes, [])

    def test_adapter_rejects_a_pdf_over_the_total_pixel_budget(self) -> None:
        engine = SequencePaddleEngine([valid_prediction("unused")])
        with TemporaryDirectory() as directory:
            source = Path(directory) / "source.pdf"
            write_blank_pdf(source, [(1_000, 1_000)] * 100)
            adapter = object.__new__(PaddleOcrAdapter)
            adapter._engine = engine
            adapter._pdf_enabled = True

            with self.assertRaises(OcrAdapterError) as raised:
                adapter.recognize(source, "application/pdf")

        self.assertEqual(raised.exception.code, "paddle_pdf_pixel_limit_exceeded")
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(engine.rendered_sizes, [])

    def test_adapter_rejects_an_empty_prediction_as_invalid_output(self) -> None:
        with TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (200, 100), "white").save(source)
            adapter = object.__new__(PaddleOcrAdapter)
            adapter._engine = EmptyPaddleEngine()

            with self.assertRaises(OcrAdapterError) as raised:
                adapter.recognize(source, "image/png")

        self.assertEqual(raised.exception.code, "paddle_output_invalid")
        self.assertFalse(raised.exception.retryable)

    def test_prediction_preserves_text_scores_and_pixel_polygons(self) -> None:
        prediction = {
            "page_index": None,
            "rec_texts": ["速刷 OCR 测试", "细胞膜的主要成分是什么？"],
            "rec_scores": [0.991, 0.954],
            "rec_polys": [
                [[100, 80], [500, 80], [500, 150], [100, 150]],
                [[120, 220], [1060, 220], [1060, 310], [120, 310]],
            ],
            "rec_boxes": [[100, 80, 500, 150], [120, 220, 1060, 310]],
        }

        page = paddle_prediction_to_page(
            prediction,
            page_number=1,
            width=1200,
            height=500,
        )

        self.assertEqual(
            page,
            OcrPage(
                page_number=1,
                width=1200,
                height=500,
                blocks=(
                    OcrBlock(
                        text="速刷 OCR 测试",
                        label="unknown",
                        bbox=(100, 80, 500, 150),
                        confidence=0.991,
                    ),
                    OcrBlock(
                        text="细胞膜的主要成分是什么？",
                        label="unknown",
                        bbox=(120, 220, 1060, 310),
                        confidence=0.954,
                    ),
                ),
            ),
        )

    def test_prediction_rejects_mismatched_text_score_and_box_counts(self) -> None:
        prediction = {
            "page_index": None,
            "rec_texts": ["第一行", "第二行"],
            "rec_scores": [0.99],
            "rec_polys": [
                [[10, 10], [90, 10], [90, 30], [10, 30]],
                [[10, 40], [90, 40], [90, 60], [10, 60]],
            ],
            "rec_boxes": [[10, 10, 90, 30], [10, 40, 90, 60]],
        }

        with self.assertRaises(OcrAdapterError) as raised:
            paddle_prediction_to_page(
                prediction,
                page_number=1,
                width=100,
                height=100,
            )

        self.assertEqual(raised.exception.code, "paddle_output_invalid")
        self.assertFalse(raised.exception.retryable)

    def test_prediction_rejects_malformed_text_score_and_box_values(self) -> None:
        valid = {
            "page_index": None,
            "rec_texts": ["有效文本"],
            "rec_scores": [0.95],
            "rec_polys": [[[10, 10], [90, 10], [90, 30], [10, 30]]],
            "rec_boxes": [[10, 10, 90, 30]],
        }
        malformed: dict[str, dict[str, object]] = {
            "missing boxes": {key: value for key, value in valid.items() if key != "rec_boxes"},
            "boolean score": {**valid, "rec_scores": [True]},
            "blank text": {**valid, "rec_texts": ["   "]},
            "short box": {**valid, "rec_boxes": [[10, 10, 90]]},
            "outside page": {**valid, "rec_boxes": [[10, 10, 101, 30]]},
            "polygon count mismatch": {**valid, "rec_polys": []},
            "unexpected page index": {**valid, "page_index": 1},
            "polygon box mismatch": {
                **valid,
                "rec_polys": [[[11, 10], [90, 10], [90, 30], [11, 30]]],
            },
        }

        for name, prediction in malformed.items():
            with self.subTest(name=name):
                with self.assertRaises(OcrAdapterError) as raised:
                    paddle_prediction_to_page(
                        prediction,
                        page_number=1,
                        width=100,
                        height=100,
                    )
                self.assertEqual(raised.exception.code, "paddle_output_invalid")
                self.assertFalse(raised.exception.retryable)
class FakePaddleResult:
    def __init__(self, prediction: dict[str, object]) -> None:
        self.json = {"res": prediction}


class FakePaddleEngine:
    def __init__(self, prediction: dict[str, object]) -> None:
        self.prediction = prediction

    def predict(self, _source_path: str) -> list[FakePaddleResult]:
        return [FakePaddleResult(self.prediction)]


class EmptyPaddleEngine:
    def predict(self, _source_path: str) -> list[FakePaddleResult]:
        return []


class SequencePaddleEngine:
    def __init__(self, predictions: list[dict[str, object]]) -> None:
        self.predictions = predictions
        self.rendered_sizes: list[tuple[int, int]] = []

    def predict(self, source_path: str) -> list[FakePaddleResult]:
        with Image.open(source_path) as image:
            self.rendered_sizes.append(image.size)
        prediction = self.predictions[len(self.rendered_sizes) - 1]
        return [FakePaddleResult(prediction)]


class StrictPaddleFactory:
    def __init__(self, prediction: dict[str, object]) -> None:
        self.prediction: dict[str, object] = prediction

    def __call__(self, **options: object) -> FakePaddleEngine:
        if options.get("text_detection_model_name") != "PP-OCRv5_mobile_det":
            raise ValueError("detection model name does not match model directory")
        if options.get("text_recognition_model_name") != "PP-OCRv5_mobile_rec":
            raise ValueError("recognition model name does not match model directory")
        return FakePaddleEngine(self.prediction)


def valid_prediction(
    text: str,
    *,
    box: list[int] | None = None,
) -> dict[str, object]:
    actual_box = box or [10, 20, 190, 60]
    left, top, right, bottom = actual_box
    return {
        "page_index": None,
        "rec_texts": [text],
        "rec_scores": [0.97],
        "rec_polys": [
            [[left, top], [right, top], [right, bottom], [left, bottom]]
        ],
        "rec_boxes": [actual_box],
    }


def write_blank_pdf(path: Path, page_sizes: list[tuple[int, int]]) -> None:
    document = pdfium.PdfDocument.new()
    try:
        for width, height in page_sizes:
            page = document.new_page(width, height)
            page.close()
        document.save(path)
    finally:
        document.close()


if __name__ == "__main__":
    unittest.main()
