from __future__ import annotations

import hmac
import json
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
from docling.datamodel.backend_options import PdfBackendOptions
from docling.datamodel.base_models import ConversionStatus, InputFormat
from docling.datamodel.pipeline_options import (
    LayoutObjectDetectionOptions,
    PdfPipelineOptions,
)
from docling.document_converter import DocumentConverter, PdfFormatOption
from sushua_document_service.storage import StorageAdapter

from .contracts import ConvertRequest, ConvertResponse, ConvertResult
from .model_artifacts import MODEL_REVISION, validated_artifacts_path
from .ocr import OcrAdapter, OcrAdapterError, OcrOutputError, to_docling_document
from .pdf_routing import PdfPageRoutingModule, merge_pdf_content

PARSER_VERSION = "2.124.0"
SUPPORTED_MIME_SUFFIXES = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "image/jpeg": ".jpg",
    "image/png": ".png",
}
OCR_IMAGE_MIME_TYPES = frozenset({"image/jpeg", "image/png"})
_PUBLIC_OCR_ERRORS = {
    "paddle_invalid_image": "ocr_invalid_source",
    "paddle_invalid_pdf": "ocr_invalid_source",
    "paddle_output_invalid": "ocr_output_invalid",
    "paddle_pdf_page_limit_exceeded": "ocr_page_limit_exceeded",
    "paddle_pdf_pixel_limit_exceeded": "ocr_pixel_limit_exceeded",
}


class DoclingServiceError(Exception):
    def __init__(self, code: str, status_code: int, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable


class DoclingConversionService:
    def __init__(
        self,
        *,
        token: str,
        storage: StorageAdapter,
        artifacts_path: str | Path | None = None,
        ocr: OcrAdapter | None = None,
        pdf_routing: PdfPageRoutingModule | None = None,
    ) -> None:
        self._token = token
        self._storage = storage
        self._ocr = ocr
        self._pdf_routing = pdf_routing or PdfPageRoutingModule()
        self._artifacts_configured = artifacts_path is not None
        self._artifacts_path = validated_artifacts_path(artifacts_path)
        self._default_converter = DocumentConverter()
        self._pdf_converter = (
            _pdf_converter(self._artifacts_path)
            if self._artifacts_path is not None
            else None
        )

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
        models_ready = not self._artifacts_configured or self._artifacts_path is not None
        return self._storage.ready() and models_ready

    def convert(self, request: ConvertRequest) -> ConvertResponse:
        self._validate_source_key(request)
        suffix = SUPPORTED_MIME_SUFFIXES.get(request.source.mime_type)
        if suffix is None:
            raise DoclingServiceError("unsupported_media_type", 415)
        ocr_setting = request.parse_config.get("ocr")
        if ocr_setting is not None and not isinstance(ocr_setting, bool):
            raise DoclingServiceError("invalid_parse_config", 422)
        use_ocr = request.source.mime_type in OCR_IMAGE_MIME_TYPES
        if (
            request.source.mime_type == "application/pdf"
            and ocr_setting is True
            and (self._ocr is None or not self._ocr.supports(request.source.mime_type))
        ):
            raise DoclingServiceError("ocr_pipeline_unavailable", 503)
        if use_ocr and (
            self._ocr is None or not self._ocr.supports(request.source.mime_type)
        ):
            raise DoclingServiceError("ocr_pipeline_unavailable", 503)
        if (
            request.source.mime_type == "application/pdf"
            and ocr_setting is not True
            and self._pdf_converter is None
        ):
            raise DoclingServiceError("pdf_models_unavailable", 503)
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
                routing = None
                if request.source.mime_type == "application/pdf":
                    if ocr_setting is True:
                        assert self._ocr is not None
                        ocr_result = self._ocr.recognize(
                            source_path,
                            request.source.mime_type,
                        )
                        routing = self._pdf_routing.forced_ocr(ocr_result)
                        converted = merge_pdf_content(None, ocr_result, routing)
                        native_content = None
                    else:
                        routing = self._pdf_routing.inspect(source_path, ocr_setting)
                        native_content = None
                        ocr_result = None
                    if routing.native_page_numbers and self._pdf_converter is None:
                        raise DoclingServiceError("pdf_models_unavailable", 503)
                    if routing.ocr_page_numbers and (
                        self._ocr is None or not self._ocr.supports(request.source.mime_type)
                    ):
                        raise DoclingServiceError("ocr_pipeline_unavailable", 503)
                    if routing.native_page_numbers and ocr_setting is not True:
                        assert self._pdf_converter is not None
                        conversion = self._pdf_converter.convert(source_path)
                        native_content = _successful_conversion_content(conversion)
                    if routing.ocr_page_numbers and ocr_setting is not True:
                        assert self._ocr is not None
                        ocr_result = self._ocr.recognize(
                            source_path,
                            request.source.mime_type,
                            routing.ocr_page_numbers,
                        )
                    if ocr_setting is not True:
                        converted = merge_pdf_content(native_content, ocr_result, routing)
                elif use_ocr:
                    assert self._ocr is not None
                    converted = to_docling_document(
                        self._ocr.recognize(source_path, request.source.mime_type)
                    )
                else:
                    converter = (
                        self._pdf_converter
                        if request.source.mime_type == "application/pdf"
                        else self._default_converter
                    )
                    assert converter is not None
                    conversion = converter.convert(source_path)
                    converted = _successful_conversion_content(conversion)
        except DoclingServiceError:
            raise
        except OcrAdapterError as error:
            public_code = _PUBLIC_OCR_ERRORS.get(error.code) if not error.retryable else None
            if public_code is not None:
                raise DoclingServiceError(public_code, 422) from error
            raise DoclingServiceError(
                "ocr_failed",
                503 if error.retryable else 422,
                retryable=error.retryable,
            ) from error
        except OcrOutputError as error:
            raise DoclingServiceError(str(error), 422) from error
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
                **({"routing": routing.as_dict()} if routing is not None else {}),
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


def _pdf_converter(artifacts_path: Path) -> DocumentConverter:
    layout_defaults = LayoutObjectDetectionOptions()
    layout_options = layout_defaults.model_copy(
        update={
            "model_spec": layout_defaults.model_spec.model_copy(
                update={"revision": MODEL_REVISION}
            )
        }
    )
    pipeline_options = PdfPipelineOptions(
        artifacts_path=artifacts_path,
        do_ocr=False,
        do_table_structure=False,
        enable_remote_services=False,
        allow_external_plugins=False,
        layout_options=layout_options,
    )
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=pipeline_options,
                backend=PyPdfiumDocumentBackend,
                backend_options=PdfBackendOptions(
                    enable_remote_fetch=False,
                    enable_local_fetch=False,
                    kind="pdf",
                    enforce_same_font=True,
                ),
            ),
        },
    )


def _successful_conversion_content(conversion: Any) -> dict[str, object]:
    if conversion.status == ConversionStatus.PARTIAL_SUCCESS:
        raise DoclingServiceError("document_conversion_partial", 422)
    if conversion.status != ConversionStatus.SUCCESS:
        raise DoclingServiceError("document_conversion_failed", 422)
    content = conversion.document.export_to_dict()
    if not isinstance(content, dict):
        raise DoclingServiceError("document_conversion_failed", 422)
    return content


def error_body(code: str, *, retryable: bool) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "error": {"code": code, "message": "request rejected", "retryable": retryable},
    }
