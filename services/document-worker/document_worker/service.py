from __future__ import annotations

import hmac
import json
from hashlib import sha256
from typing import Any

from sushua_document_service.storage import StorageAdapter

from .contracts import ParseRequest, ParseResponse, ParseResult
from .parsers import DocumentParser, ParserContext, ParserError


class DocumentServiceError(Exception):
    def __init__(self, code: str, status_code: int, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable


class DocumentProcessingService:
    def __init__(
        self,
        *,
        token: str,
        storage: StorageAdapter,
        parsers: list[DocumentParser],
    ) -> None:
        self._token = token
        self._storage = storage
        self._parsers = parsers

    def authenticate(self, authorization: str | None) -> None:
        prefix = "Bearer "
        candidate = (
            authorization[len(prefix) :]
            if authorization and authorization.startswith(prefix)
            else ""
        )
        if not candidate or not hmac.compare_digest(candidate, self._token):
            raise DocumentServiceError("invalid_service_token", 401)

    def ready(self) -> bool:
        return self._storage.ready() and bool(self._parsers)

    def parse(self, request: ParseRequest) -> ParseResponse:
        self._validate_source_key(request)
        parser = next(
            (
                candidate
                for candidate in self._parsers
                if candidate.supports(request.source.mime_type)
            ),
            None,
        )
        if parser is None:
            raise DocumentServiceError("unsupported_media_type", 415)
        try:
            source = self._storage.read(request.source.object_key)
        except FileNotFoundError as error:
            raise DocumentServiceError("source_object_not_found", 404) from error
        except (OSError, ValueError) as error:
            raise DocumentServiceError("source_object_unavailable", 503, retryable=True) from error
        if len(source) != request.source.size_bytes or not hmac.compare_digest(
            sha256(source).hexdigest(), request.source.sha256
        ):
            raise DocumentServiceError("source_integrity_mismatch", 409)
        try:
            parsed = parser.parse(
                source,
                request.source.mime_type,
                request.source.sha256,
                ParserContext(
                    trace_id=request.trace_id,
                    workspace_id=request.workspace_id,
                    document_id=request.document_id,
                    document_version_id=request.document_version_id,
                    source=request.source,
                    parse_config=request.parse_config,
                ),
            )
        except ParserError as error:
            raise DocumentServiceError(
                error.code,
                error.status_code,
                retryable=error.retryable,
            ) from error
        except ValueError as error:
            raise DocumentServiceError(str(error), 422) from error

        ir_object_key = (
            f"tenant/{request.workspace_id}/{request.document_id}/"
            f"{request.document_version_id}/ir/document-ir.json"
        )
        ir = {
            "schemaVersion": request.ir_schema_version,
            "document": {
                "id": request.document_id,
                "workspaceId": request.workspace_id,
                "documentVersionId": request.document_version_id,
                "source": request.source.model_dump(by_alias=True),
                "parseConfig": request.parse_config,
                "parser": {"name": parsed.parser, "version": parsed.parser_version},
                "pages": parsed.pages,
            },
        }
        ir_bytes = json.dumps(
            ir,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        try:
            self._storage.write(ir_object_key, ir_bytes)
        except (OSError, ValueError) as error:
            raise DocumentServiceError("ir_object_unavailable", 503, retryable=True) from error
        return ParseResponse(
            result=ParseResult(
                irObjectKey=ir_object_key,
                irSha256=sha256(ir_bytes).hexdigest(),
                parser=parsed.parser,
                parserVersion=parsed.parser_version,
                pageCount=len(parsed.pages),
                irSchemaVersion=request.ir_schema_version,
            )
        )

    @staticmethod
    def _validate_source_key(request: ParseRequest) -> None:
        expected_prefix = (
            f"tenant/{request.workspace_id}/{request.document_id}/"
            f"{request.document_version_id}/source/"
        )
        key = request.source.object_key
        suffix = key.removeprefix(expected_prefix)
        if (
            not key.startswith(expected_prefix)
            or not suffix
            or "/" in suffix
            or suffix in {".", ".."}
        ):
            raise DocumentServiceError("invalid_object_key", 422)


def error_body(code: str, *, retryable: bool) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "error": {"code": code, "message": "request rejected", "retryable": retryable},
    }
