from __future__ import annotations

import base64
import json
import os
import sys
from hashlib import sha256
from pathlib import Path

import cv2
from docling.document_converter import DocumentConverter
from PIL import Image

from docling_service.paddle_ocr_adapter import paddle_adapter_from_environment

EXPECTED_SHA256 = "19588f23a55ded05245de1fcfdfe2425b1ee913522d16d743d4f04306b878dee"


def main() -> None:
    encoded_path = Path(sys.argv[1])
    source = base64.b64decode(encoded_path.read_bytes().strip(), validate=True)
    if sha256(source).hexdigest() != EXPECTED_SHA256:
        raise AssertionError("fixture checksum mismatch")
    source_path = Path("/tmp/paddleocr-ch-doc1.jpg")
    source_path.write_bytes(source)
    adapter = paddle_adapter_from_environment(os.environ)
    if adapter is None:
        raise AssertionError("PaddleOCR adapter is disabled")
    result = adapter.recognize(source_path, "image/jpeg")
    if len(result.pages) != 1 or len(result.pages[0].blocks) != 1:
        raise AssertionError("expected one OCR page and one text block")
    page = result.pages[0]
    block = page.blocks[0]
    if (page.width, page.height) != (280, 32):
        raise AssertionError("image geometry changed")
    if block.text != "如，和对旅游表演形式":
        raise AssertionError(f"unexpected OCR text: {block.text}")
    if block.bbox != (3, 1, 278, 30) or block.confidence < 0.99:
        raise AssertionError("OCR location or confidence regressed")

    scanned_pdf_path = Path("/tmp/paddleocr-scanned.pdf")
    with Image.open(source_path) as image:
        second_page = image.copy()
        image.save(
            scanned_pdf_path,
            format="PDF",
            save_all=True,
            append_images=[second_page],
            resolution=72,
        )
    pdf_result = adapter.recognize(scanned_pdf_path, "application/pdf")
    if len(pdf_result.pages) != 2:
        raise AssertionError("expected two rendered OCR pages")
    for page_number, pdf_page in enumerate(pdf_result.pages, start=1):
        if pdf_page.page_number != page_number or (pdf_page.width, pdf_page.height) != (560, 64):
            raise AssertionError("scanned PDF page geometry changed")
        if len(pdf_page.blocks) != 1:
            raise AssertionError("expected one OCR block on each scanned PDF page")
        pdf_block = pdf_page.blocks[0]
        left, top, right, bottom = pdf_block.bbox
        if (
            pdf_block.text != "如，和对旅游表演形式"
            or pdf_block.confidence < 0.99
            or not 0 <= left < right <= pdf_page.width
            or not 0 <= top < bottom <= pdf_page.height
        ):
            raise AssertionError("scanned PDF OCR content or provenance regressed")
    print(
        json.dumps(
            {
                "text": block.text,
                "bbox": block.bbox,
                "confidence": block.confidence,
                "pdfText": pdf_result.pages[0].blocks[0].text,
                "pdfPages": len(pdf_result.pages),
                "pdfSize": [pdf_result.pages[0].width, pdf_result.pages[0].height],
                "pdfBbox": pdf_result.pages[0].blocks[0].bbox,
                "cv2Version": cv2.__version__,
                "doclingImport": DocumentConverter.__name__,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
