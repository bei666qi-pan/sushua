from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

UUID_V7_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
MIME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=False)


class SourceReference(StrictModel):
    asset_id: str = Field(alias="assetId")
    object_key: str = Field(alias="objectKey", min_length=1, max_length=1024)
    sha256: str
    size_bytes: int = Field(alias="sizeBytes", ge=1, le=200 * 1024 * 1024)
    mime_type: str = Field(alias="mimeType", min_length=3, max_length=255)

    @field_validator("asset_id")
    @classmethod
    def validate_asset_id(cls, value: str) -> str:
        return uuid_v7(value)

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        if not SHA256_PATTERN.fullmatch(value):
            raise ValueError("invalid sha256")
        return value

    @field_validator("mime_type")
    @classmethod
    def validate_mime_type(cls, value: str) -> str:
        if not MIME_PATTERN.fullmatch(value):
            raise ValueError("invalid mime type")
        return value


class ParseRequest(StrictModel):
    schema_version: Literal[1] = Field(alias="schemaVersion")
    job_id: str = Field(alias="jobId")
    trace_id: str = Field(alias="traceId")
    workspace_id: str = Field(alias="workspaceId")
    document_id: str = Field(alias="documentId")
    document_version_id: str = Field(alias="documentVersionId")
    source: SourceReference
    parse_config: dict[str, Any] = Field(alias="parseConfig")
    ir_schema_version: Literal["sushua.document-ir.v1"] = Field(alias="irSchemaVersion")

    @field_validator(
        "job_id",
        "trace_id",
        "workspace_id",
        "document_id",
        "document_version_id",
    )
    @classmethod
    def validate_uuid_v7(cls, value: str) -> str:
        return uuid_v7(value)


class ParseResult(StrictModel):
    ir_object_key: str = Field(alias="irObjectKey")
    ir_sha256: str = Field(alias="irSha256")
    parser: str
    parser_version: str = Field(alias="parserVersion")
    page_count: int = Field(alias="pageCount", ge=1, le=10_000)
    ir_schema_version: Literal["sushua.document-ir.v1"] = Field(alias="irSchemaVersion")


class ParseResponse(StrictModel):
    schema_version: Literal[1] = Field(alias="schemaVersion", default=1)
    result: ParseResult


def uuid_v7(value: str) -> str:
    if not UUID_V7_PATTERN.fullmatch(value):
        raise ValueError("invalid uuid v7")
    return value.lower()
