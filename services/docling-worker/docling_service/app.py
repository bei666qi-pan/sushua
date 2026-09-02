from __future__ import annotations

import os

from fastapi import FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sushua_document_service.storage import storage_from_environment

from .contracts import ConvertRequest, ConvertResponse
from .service import DoclingConversionService, DoclingServiceError, error_body


def create_app() -> FastAPI:
    token = os.environ.get("DOCLING_SERVICE_TOKEN", "")
    if not 32 <= len(token) <= 512 or "\r" in token or "\n" in token:
        raise RuntimeError("invalid_docling_service_token")
    service = DoclingConversionService(
        token=token,
        storage=storage_from_environment(os.environ),
        artifacts_path=os.environ.get("DOCLING_ARTIFACTS_PATH") or None,
    )
    app = FastAPI(
        title="SuShua Docling Service",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.exception_handler(DoclingServiceError)
    async def handle_service_error(_request: Request, error: DoclingServiceError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status_code,
            content=error_body(error.code, retryable=error.retryable),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _request: Request,
        _error: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=error_body("invalid_request", retryable=False),
        )

    @app.get("/health/live")
    async def live() -> dict[str, int | str]:
        return {"schemaVersion": 1, "status": "live"}

    @app.get("/health/ready")
    async def ready() -> JSONResponse:
        status = 200 if service.ready() else 503
        return JSONResponse(
            status_code=status,
            content={"schemaVersion": 1, "status": "ready" if status == 200 else "not_ready"},
        )

    @app.post("/v1/convert", response_model=ConvertResponse, response_model_by_alias=True)
    async def convert(
        body: ConvertRequest,
        authorization: str | None = Header(default=None),
    ) -> ConvertResponse:
        service.authenticate(authorization)
        return service.convert(body)

    return app


app = create_app()
