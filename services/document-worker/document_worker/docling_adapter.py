from __future__ import annotations

import hmac
import json
import math
from collections.abc import Mapping
from hashlib import sha256
from typing import Any, TypeGuard
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from pydantic import ValidationError
from sushua_document_service.docling_contracts import (
    DoclingConvertRequest,
    DoclingConvertResponse,
)
from sushua_document_service.storage import StorageAdapter

from .parsers import ParsedDocument, ParserContext, ParserError, _sha256_text

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PDF_MIME = "application/pdf"
OCR_IMAGE_MIME_TYPES = frozenset({"image/jpeg", "image/png"})
_PRESERVED_DOCLING_ERRORS = {
    (422, "document_conversion_failed"): False,
    (422, "document_conversion_partial"): False,
    (422, "ocr_required"): False,
    (422, "ocr_output_empty"): False,
    (422, "ocr_output_invalid"): False,
    (503, "pdf_models_unavailable"): False,
    (503, "ocr_pipeline_unavailable"): False,
    (503, "ocr_failed"): True,
}


class DoclingAdapterError(ParserError):
    pass


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


class DoclingParserAdapter:
    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        timeout_seconds: int,
        storage: StorageAdapter,
        native_pdf_enabled: bool = False,
        ocr_image_enabled: bool = False,
    ) -> None:
        self._endpoint = endpoint(base_url)
        if not 32 <= len(token) <= 512 or "\r" in token or "\n" in token:
            raise RuntimeError("invalid_docling_service_token")
        if not 1 <= timeout_seconds <= 1800:
            raise RuntimeError("invalid_docling_service_timeout")
        self._token = token
        self._timeout_seconds = timeout_seconds
        self._storage = storage
        self._native_pdf_enabled = native_pdf_enabled
        self._ocr_image_enabled = ocr_image_enabled

    def supports(self, mime_type: str) -> bool:
        return (
            mime_type == DOCX_MIME
            or (mime_type == PDF_MIME and self._native_pdf_enabled)
            or (mime_type in OCR_IMAGE_MIME_TYPES and self._ocr_image_enabled)
        )

    def parse(
        self,
        content: bytes,
        mime_type: str,
        source_sha256: str,
        context: ParserContext | None = None,
    ) -> ParsedDocument:
        if not self.supports(mime_type):
            raise ValueError("unsupported_media_type")
        if context is None:
            raise ValueError("missing_parser_context")
        request_body = DoclingConvertRequest(
            schemaVersion=1,
            traceId=context.trace_id,
            workspaceId=context.workspace_id,
            documentId=context.document_id,
            documentVersionId=context.document_version_id,
            source=context.source,
            parseConfig=context.parse_config,
            outputSchemaVersion="sushua.docling-output.v1",
        ).model_dump_json(by_alias=True).encode("utf-8")
        converted = self._request_conversion(request_body)
        expected_key = (
            f"tenant/{context.workspace_id}/{context.document_id}/"
            f"{context.document_version_id}/conversion/docling.json"
        )
        if converted.result.conversion_object_key != expected_key:
            raise DoclingAdapterError("docling_protocol_error", 502)
        try:
            output = self._storage.read(expected_key)
        except (FileNotFoundError, OSError, ValueError) as error:
            raise DoclingAdapterError(
                "docling_output_unavailable", 503, retryable=True
            ) from error
        if len(output) > 256 * 1024 * 1024 or not hmac.compare_digest(
            sha256(output).hexdigest(), converted.result.conversion_sha256
        ):
            raise DoclingAdapterError("docling_output_integrity_mismatch", 502)
        return convert_output(
            output,
            context=context,
            source_sha256=source_sha256,
            parser_version=converted.result.parser_version,
        )

    def _request_conversion(self, body: bytes) -> DoclingConvertResponse:
        request = Request(
            self._endpoint,
            data=body,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with build_opener(ProxyHandler({}), _RejectRedirects()).open(
                request,
                timeout=self._timeout_seconds,
            ) as response:
                if (
                    response.status != 200
                    or response.headers.get_content_type() != "application/json"
                ):
                    raise DoclingAdapterError("docling_protocol_error", 502)
                response_body = response.read(65_537)
        except HTTPError as error:
            if 300 <= error.code < 400:
                raise DoclingAdapterError("docling_protocol_error", 502) from error
            preserved = _preserved_docling_error(error)
            if preserved is not None:
                code, retryable = preserved
                raise DoclingAdapterError(
                    code,
                    error.code,
                    retryable=retryable,
                ) from error
            if error.code in {408, 429} or error.code >= 500:
                raise DoclingAdapterError(
                    "docling_service_unavailable", 503, retryable=True
                ) from error
            if error.code in {401, 403}:
                raise DoclingAdapterError("docling_service_auth_failed", 502) from error
            raise DoclingAdapterError("docling_request_rejected", 422) from error
        except (TimeoutError, URLError, OSError) as error:
            raise DoclingAdapterError(
                "docling_service_unavailable", 503, retryable=True
            ) from error
        if len(response_body) > 65_536:
            raise DoclingAdapterError("docling_protocol_error", 502)
        try:
            return DoclingConvertResponse.model_validate_json(response_body)
        except ValidationError as error:
            raise DoclingAdapterError("docling_protocol_error", 502) from error


def _preserved_docling_error(error: HTTPError) -> tuple[str, bool] | None:
    if error.headers.get_content_type() != "application/json":
        return None
    body = error.read(65_537)
    if len(body) > 65_536:
        return None
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or set(payload) != {"schemaVersion", "error"}:
        return None
    detail = payload.get("error")
    if (
        payload.get("schemaVersion") != 1
        or not isinstance(detail, dict)
        or set(detail) != {"code", "message", "retryable"}
        or detail.get("message") != "request rejected"
        or not isinstance(detail.get("code"), str)
        or not isinstance(detail.get("retryable"), bool)
    ):
        return None
    code = detail["code"]
    retryable = detail["retryable"]
    expected_retryable = _PRESERVED_DOCLING_ERRORS.get((error.code, code))
    if expected_retryable is None or retryable is not expected_retryable:
        return None
    return code, retryable


def adapter_from_environment(
    environment: Mapping[str, str],
    storage: StorageAdapter,
) -> DoclingParserAdapter | None:
    base_url = environment.get("DOCLING_SERVICE_URL", "")
    token = environment.get("DOCLING_SERVICE_TOKEN", "")
    if not base_url and not token:
        return None
    if not base_url or not token:
        raise RuntimeError("incomplete_docling_service_configuration")
    raw_timeout = environment.get("DOCLING_SERVICE_TIMEOUT_SECONDS", "900")
    try:
        timeout_seconds = int(raw_timeout)
    except ValueError as error:
        raise RuntimeError("invalid_docling_service_timeout") from error
    return DoclingParserAdapter(
        base_url=base_url,
        token=token,
        timeout_seconds=timeout_seconds,
        storage=storage,
        native_pdf_enabled=_enabled(environment.get("DOCLING_NATIVE_PDF_ENABLED")),
        ocr_image_enabled=_enabled(environment.get("DOCLING_OCR_IMAGE_ENABLED")),
    )


def _enabled(value: str | None) -> bool:
    return value is not None and value.strip().lower() in {"1", "true", "yes", "on"}


def endpoint(base_url: str) -> str:
    parsed = urlparse(base_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("invalid_docling_service_url")
    path = f"{parsed.path.rstrip('/')}/v1/convert"
    return parsed._replace(path=path).geturl()


def convert_output(
    output: bytes,
    *,
    context: ParserContext,
    source_sha256: str,
    parser_version: str,
) -> ParsedDocument:
    try:
        envelope = json.loads(output)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DoclingAdapterError("docling_protocol_error", 502) from error
    if not isinstance(envelope, dict) or set(envelope) != {"schemaVersion", "document"}:
        raise DoclingAdapterError("docling_protocol_error", 502)
    document = envelope.get("document")
    if envelope.get("schemaVersion") != "sushua.docling-output.v1" or not isinstance(
        document, dict
    ):
        raise DoclingAdapterError("docling_protocol_error", 502)
    if (
        document.get("id") != context.document_id
        or document.get("workspaceId") != context.workspace_id
        or document.get("documentVersionId") != context.document_version_id
        or document.get("source") != context.source.model_dump(by_alias=True)
        or document.get("parseConfig") != context.parse_config
        or document.get("parser") != {"name": "docling", "version": parser_version}
    ):
        raise DoclingAdapterError("docling_protocol_error", 502)
    content = document.get("content")
    if (
        not isinstance(content, dict)
        or content.get("schema_name") != "DoclingDocument"
        or not isinstance(content.get("texts"), list)
    ):
        raise DoclingAdapterError("docling_protocol_error", 502)
    for collection_name in ("tables", "pictures", "key_value_items", "form_items"):
        collection = content.get(collection_name, [])
        if not isinstance(collection, list):
            raise DoclingAdapterError("docling_protocol_error", 502)
        if collection:
            raise DoclingAdapterError("docling_unsupported_structure", 422)
    if context.source.mime_type == PDF_MIME or context.source.mime_type in OCR_IMAGE_MIME_TYPES:
        pages = _convert_pdf_pages(
            content,
            source_sha256=source_sha256,
            parser_version=parser_version,
        )
    else:
        pages = _convert_logical_page(
            content,
            source_sha256=source_sha256,
            parser_version=parser_version,
        )
    return ParsedDocument(
        parser="docling",
        parser_version=parser_version,
        pages=pages,
    )


def _convert_logical_page(
    content: dict[str, Any],
    *,
    source_sha256: str,
    parser_version: str,
) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    bbox: list[int | float] = [0, 0, 1, 1]
    for item in content["texts"]:
        text = _text(item)
        if not text:
            continue
        blocks.append(
            _block(
                item,
                text=text,
                bbox=bbox,
                block_id=len(blocks) + 1,
                reading_order=len(blocks),
                source_sha256=source_sha256,
                parser_version=parser_version,
            )
        )
    if not blocks:
        raise DoclingAdapterError("docling_output_empty", 422)
    return [{"pageNumber": 1, "width": 1, "height": 1, "blocks": blocks}]


def _convert_pdf_pages(
    content: dict[str, Any],
    *,
    source_sha256: str,
    parser_version: str,
) -> list[dict[str, Any]]:
    raw_pages = content.get("pages")
    if not isinstance(raw_pages, dict) or not raw_pages:
        raise DoclingAdapterError("docling_invalid_provenance", 422)

    pages_by_number: dict[int, dict[str, Any]] = {}
    dimensions: dict[int, tuple[int | float, int | float]] = {}
    for page_key, raw_page in raw_pages.items():
        if not isinstance(page_key, str) or not isinstance(raw_page, dict):
            raise DoclingAdapterError("docling_invalid_provenance", 422)
        page_number = raw_page.get("page_no")
        size = raw_page.get("size")
        if (
            not _positive_integer(page_number)
            or page_key != str(page_number)
            or not isinstance(size, dict)
        ):
            raise DoclingAdapterError("docling_invalid_provenance", 422)
        width = _positive_number(size.get("width"))
        height = _positive_number(size.get("height"))
        if width is None or height is None or page_number in pages_by_number:
            raise DoclingAdapterError("docling_invalid_provenance", 422)
        pages_by_number[page_number] = {
            "pageNumber": page_number,
            "width": width,
            "height": height,
            "blocks": [],
        }
        dimensions[page_number] = (width, height)

    ordered_numbers = sorted(pages_by_number)
    if ordered_numbers != list(range(1, len(ordered_numbers) + 1)):
        raise DoclingAdapterError("docling_invalid_provenance", 422)

    next_block_id = 1
    for item in content["texts"]:
        text = _text(item)
        if not text:
            continue
        page_number, bbox = _pdf_item_bbox(item, dimensions)
        blocks = pages_by_number[page_number]["blocks"]
        blocks.append(
            _block(
                item,
                text=text,
                bbox=bbox,
                block_id=next_block_id,
                reading_order=len(blocks),
                source_sha256=source_sha256,
                parser_version=parser_version,
            )
        )
        next_block_id += 1

    if next_block_id == 1:
        raise DoclingAdapterError("docling_output_empty", 422)
    if any(not pages_by_number[number]["blocks"] for number in ordered_numbers):
        raise DoclingAdapterError("ocr_required", 422)
    return [pages_by_number[number] for number in ordered_numbers]


def _pdf_item_bbox(
    item: dict[str, Any],
    dimensions: dict[int, tuple[int | float, int | float]],
) -> tuple[int, list[float]]:
    provenance = item.get("prov")
    raw_text = item.get("text")
    if (
        not isinstance(provenance, list)
        or len(provenance) != 1
        or not isinstance(raw_text, str)
    ):
        raise DoclingAdapterError("docling_invalid_provenance", 422)

    entry = provenance[0]
    if not isinstance(entry, dict) or not _positive_integer(entry.get("page_no")):
        raise DoclingAdapterError("docling_invalid_provenance", 422)
    charspan = entry.get("charspan")
    if (
        not isinstance(charspan, list)
        or len(charspan) != 2
        or any(not isinstance(value, int) or isinstance(value, bool) for value in charspan)
        or charspan != [0, len(raw_text)]
    ):
        raise DoclingAdapterError("docling_invalid_provenance", 422)
    page_number = entry["page_no"]
    if page_number not in dimensions:
        raise DoclingAdapterError("docling_invalid_provenance", 422)
    width, height = dimensions[page_number]
    return page_number, _normalize_bbox(entry.get("bbox"), width, height)


def _normalize_bbox(
    raw_bbox: object,
    page_width: int | float,
    page_height: int | float,
) -> list[float]:
    if not isinstance(raw_bbox, dict):
        raise DoclingAdapterError("docling_invalid_provenance", 422)
    left = _number(raw_bbox.get("l"))
    top = _number(raw_bbox.get("t"))
    right = _number(raw_bbox.get("r"))
    bottom = _number(raw_bbox.get("b"))
    origin = raw_bbox.get("coord_origin")
    if None in {left, top, right, bottom} or origin not in {"BOTTOMLEFT", "TOPLEFT"}:
        raise DoclingAdapterError("docling_invalid_provenance", 422)
    assert left is not None and top is not None and right is not None and bottom is not None

    if origin == "BOTTOMLEFT":
        valid = 0 <= left < right <= page_width and 0 <= bottom < top <= page_height
        normalized_top = (page_height - top) / page_height
        normalized_height = (top - bottom) / page_height
    else:
        valid = 0 <= left < right <= page_width and 0 <= top < bottom <= page_height
        normalized_top = top / page_height
        normalized_height = (bottom - top) / page_height
    if not valid:
        raise DoclingAdapterError("docling_invalid_provenance", 422)
    return [
        _clean_float(left / page_width),
        _clean_float(normalized_top),
        _clean_float((right - left) / page_width),
        _clean_float(normalized_height),
    ]


def _block(
    item: dict[str, Any],
    *,
    text: str,
    bbox: list[int | float],
    block_id: int,
    reading_order: int,
    source_sha256: str,
    parser_version: str,
) -> dict[str, Any]:
    label = item.get("label")
    level = item.get("level")
    heading_level: int | None = None
    if label == "section_header":
        if (
            not isinstance(level, int)
            or isinstance(level, bool)
            or not 1 <= level <= 6
        ):
            raise DoclingAdapterError("docling_unsupported_structure", 422)
        heading_level = level
        block_type = "heading"
    elif label in {"text", "paragraph"}:
        block_type = "text"
    else:
        block_type = "unknown"
    markdown = (
        f"{'#' * (heading_level or 1)} {text}"
        if block_type == "heading"
        else text
    )
    block: dict[str, Any] = {
        "blockId": f"block-{block_id}",
        "blockType": block_type,
        "text": text,
        "markdown": markdown,
        "bbox": bbox,
        "readingOrder": reading_order,
        "confidence": _confidence(item),
        "sourceHash": _sha256_text(
            f"{parser_version}\n{text}\n{','.join(str(value) for value in bbox)}\n"
            f"{source_sha256}"
        ),
    }
    if heading_level is not None:
        block["headingLevel"] = heading_level
    return block


def _text(item: object) -> str:
    if not isinstance(item, dict) or not isinstance(item.get("text"), str):
        raise DoclingAdapterError("docling_protocol_error", 502)
    return item["text"].strip()


def _confidence(item: dict[str, Any]) -> float:
    value = item.get("confidence", 0.85)
    number = _number(value)
    if number is None or not 0 <= number <= 1:
        raise DoclingAdapterError("docling_protocol_error", 502)
    return float(number)


def _positive_integer(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _positive_number(value: object) -> int | float | None:
    number = _number(value)
    return number if number is not None and number > 0 else None


def _number(value: object) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value):
        return None
    return value


def _clean_float(value: float) -> float:
    rounded = round(value, 12)
    return 0.0 if rounded == 0 else rounded
