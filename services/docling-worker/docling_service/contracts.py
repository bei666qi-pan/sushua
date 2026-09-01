from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, field_validator
from sushua_document_service.contracts import SourceReference, StrictModel, uuid_v7


class ConvertRequest(StrictModel):
    schema_version: Literal[1] = Field(alias="schemaVersion")
    trace_id: str = Field(alias="traceId")
    workspace_id: str = Field(alias="workspaceId")
    document_id: str = Field(alias="documentId")
    document_version_id: str = Field(alias="documentVersionId")
    source: SourceReference
    parse_config: dict[str, Any] = Field(alias="parseConfig")
    output_schema_version: Literal["sushua.docling-output.v1"] = Field(
        alias="outputSchemaVersion"
    )

    @field_validator("trace_id", "workspace_id", "document_id", "document_version_id")
    @classmethod
    def validate_uuid_v7(cls, value: str) -> str:
        return uuid_v7(value)


class ConvertResult(StrictModel):
    conversion_object_key: str = Field(alias="conversionObjectKey")
    conversion_sha256: str = Field(alias="conversionSha256")
    parser: Literal["docling"]
    parser_version: str = Field(alias="parserVersion")
    output_schema_version: Literal["sushua.docling-output.v1"] = Field(
        alias="outputSchemaVersion"
    )


class ConvertResponse(StrictModel):
    schema_version: Literal[1] = Field(alias="schemaVersion", default=1)
    result: ConvertResult
