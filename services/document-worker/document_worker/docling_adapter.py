from __future__ import annotations

import hmac
import json
from collections.abc import Mapping
from hashlib import sha256
from typing import Any
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
    ) -> None:
        self._endpoint = endpoint(base_url)
        if not 32 <= len(token) <= 512 or "\r" in token or "\n" in token:
            raise RuntimeError("invalid_docling_service_token")
        if not 1 <= timeout_seconds <= 1800:
            raise RuntimeError("invalid_docling_service_timeout")
        self._token = token
        self._timeout_seconds = timeout_seconds
        self._storage = storage

    def supports(self, mime_type: str) -> bool:
        return mime_type == DOCX_MIME

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
    raw_timeout = environment.get("DOCLING_SERVICE_TIMEOUT_SECONDS", "180")
    try:
        timeout_seconds = int(raw_timeout)
    except ValueError as error:
        raise RuntimeError("invalid_docling_service_timeout") from error
    return DoclingParserAdapter(
        base_url=base_url,
        token=token,
        timeout_seconds=timeout_seconds,
        storage=storage,
    )


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
    blocks: list[dict[str, Any]] = []
    bbox = [0, 0, 1, 1]
    for item in content["texts"]:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            raise DoclingAdapterError("docling_protocol_error", 502)
        text = item["text"].strip()
        if not text:
            continue
        label = item.get("label")
        level = item.get("level")
        heading_level = level if label == "section_header" and isinstance(level, int) else None
        block_type = "heading" if heading_level is not None else "text"
        markdown = (
            f"{'#' * max(1, min(heading_level or 1, 6))} {text}"
            if block_type == "heading"
            else text
        )
        block: dict[str, Any] = {
            "blockId": f"block-{len(blocks) + 1}",
            "blockType": block_type,
            "text": text,
            "markdown": markdown,
            "bbox": bbox,
            "readingOrder": len(blocks),
            "confidence": 0.85,
            "sourceHash": _sha256_text(
                f"{parser_version}\n{text}\n{','.join(str(value) for value in bbox)}\n"
                f"{source_sha256}"
            ),
        }
        if heading_level is not None:
            block["headingLevel"] = max(1, min(heading_level, 6))
        blocks.append(block)
    if not blocks:
        raise DoclingAdapterError("docling_output_empty", 422)
    return ParsedDocument(
        parser="docling",
        parser_version=parser_version,
        pages=[{"pageNumber": 1, "width": 1, "height": 1, "blocks": blocks}],
    )
