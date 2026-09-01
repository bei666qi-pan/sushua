from __future__ import annotations

import hmac
import json
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from docling.document_converter import DocumentConverter
from sushua_document_service.storage import StorageAdapter

from .contracts import ConvertRequest, ConvertResponse, ConvertResult

PARSER_VERSION = "2.124.0"
SUPPORTED_MIME_SUFFIXES = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
}


class DoclingServiceError(Exception):
    def __init__(self, code: str, status_code: int, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable


class DoclingConversionService:
    def __init__(self, *, token: str, storage: StorageAdapter) -> None:
        self._token = token
        self._storage = storage

    def authenticate(self, authorization: str | None) -> None:
        prefix = "Bearer "
        candidate = (
            authorization[len(prefix) :]
            if authorization and authorization.startswith(prefix)
            else ""
        )
        if not candidate or not hmac.compare_digest(candidate, self._token):
            raise DoclingServiceError("invalid_service_token", 401)

    def ready(self) -> bool:
        return self._storage.ready()

    def convert(self, request: ConvertRequest) -> ConvertResponse:
        self._validate_source_key(request)
        suffix = SUPPORTED_MIME_SUFFIXES.get(request.source.mime_type)
        if suffix is None:
            raise DoclingServiceError("unsupported_media_type", 415)
        try:
            source = self._storage.read(request.source.object_key)
        except FileNotFoundError as error:
            raise DoclingServiceError("source_object_not_found", 404) from error
        except (OSError, ValueError) as error:
            raise DoclingServiceError("source_object_unavailable", 503, retryable=True) from error
        if len(source) != request.source.size_bytes or not hmac.compare_digest(
            sha256(source).hexdigest(), request.source.sha256
        ):
            raise DoclingServiceError("source_integrity_mismatch", 409)

        try:
            with TemporaryDirectory(prefix="sushua-docling-") as directory:
                source_path = Path(directory) / f"source{suffix}"
                source_path.write_bytes(source)
                converted = DocumentConverter().convert(source_path).document.export_to_dict()
        except Exception as error:
            raise DoclingServiceError("document_conversion_failed", 422) from error

        conversion_object_key = (
            f"tenant/{request.workspace_id}/{request.document_id}/"
            f"{request.document_version_id}/conversion/docling.json"
        )
        output = {
            "schemaVersion": request.output_schema_version,
            "document": {
                "id": request.document_id,
                "workspaceId": request.workspace_id,
                "documentVersionId": request.document_version_id,
                "source": request.source.model_dump(by_alias=True),
                "parseConfig": request.parse_config,
                "parser": {"name": "docling", "version": PARSER_VERSION},
                "content": converted,
            },
        }
        output_bytes = json.dumps(
            output,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        try:
            self._storage.write(conversion_object_key, output_bytes)
        except (OSError, ValueError) as error:
            raise DoclingServiceError(
                "conversion_object_unavailable", 503, retryable=True
            ) from error
        return ConvertResponse(
            result=ConvertResult(
                conversionObjectKey=conversion_object_key,
                conversionSha256=sha256(output_bytes).hexdigest(),
                parser="docling",
                parserVersion=PARSER_VERSION,
                outputSchemaVersion=request.output_schema_version,
            )
        )

    @staticmethod
    def _validate_source_key(request: ConvertRequest) -> None:
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
            raise DoclingServiceError("invalid_object_key", 422)


def error_body(code: str, *, retryable: bool) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "error": {"code": code, "message": "request rejected", "retryable": retryable},
    }
