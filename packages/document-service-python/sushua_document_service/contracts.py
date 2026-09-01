from __future__ import annotations

import re

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


def uuid_v7(value: str) -> str:
    if not UUID_V7_PATTERN.fullmatch(value):
        raise ValueError("invalid uuid v7")
    return value.lower()
