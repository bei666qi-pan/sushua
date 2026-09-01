from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import TYPE_CHECKING, Any, Protocol
from urllib.parse import urlparse

import boto3
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client
else:
    S3Client = Any


class StorageAdapter(Protocol):
    def read(self, object_key: str) -> bytes: ...

    def write(self, object_key: str, content: bytes) -> None: ...

    def ready(self) -> bool: ...


class LocalObjectStorage:
    def __init__(self, root: Path) -> None:
        self._root = root.resolve(strict=True)
        if not self._root.is_dir():
            raise ValueError("invalid_document_storage_root")

    def read(self, object_key: str) -> bytes:
        return self._resolve(object_key).read_bytes()

    def write(self, object_key: str, content: bytes) -> None:
        target = self._resolve(object_key)
        target.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(dir=target.parent, prefix=".document-ir-", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)

    def ready(self) -> bool:
        return self._root.is_dir() and os.access(self._root, os.R_OK | os.W_OK)

    def _resolve(self, object_key: str) -> Path:
        segments = validate_object_key(object_key)
        candidate = self._root.joinpath(*segments).resolve(strict=False)
        if not candidate.is_relative_to(self._root):
            raise ValueError("invalid_object_key")
        return candidate


class S3ObjectStorage:
    def __init__(self, *, client: S3Client, bucket: str) -> None:
        if not valid_bucket(bucket):
            raise ValueError("invalid_s3_bucket")
        self._client = client
        self._bucket = bucket

    def read(self, object_key: str) -> bytes:
        validate_object_key(object_key)
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=object_key)
            content = response["Body"].read()
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "")
            if code in {"NoSuchKey", "404", "NotFound"}:
                raise FileNotFoundError("source_object_not_found") from error
            raise OSError("s3_read_failed") from error
        except BotoCoreError as error:
            raise OSError("s3_read_failed") from error
        if not isinstance(content, bytes):
            raise OSError("s3_invalid_body")
        return content

    def write(self, object_key: str, content: bytes) -> None:
        validate_object_key(object_key)
        try:
            self._client.put_object(
                Bucket=self._bucket,
                Key=object_key,
                Body=content,
                ContentType="application/json",
            )
        except (BotoCoreError, ClientError) as error:
            raise OSError("s3_write_failed") from error

    def ready(self) -> bool:
        try:
            self._client.head_bucket(Bucket=self._bucket)
            return True
        except (BotoCoreError, ClientError):
            return False


def storage_from_environment(environment: Mapping[str, str]) -> StorageAdapter:
    driver = environment.get("STORAGE_DRIVER", "local")
    if driver == "local":
        root = environment.get("DOCUMENT_STORAGE_ROOT", "")
        if not root:
            raise RuntimeError("missing_document_storage_root")
        return LocalObjectStorage(Path(root))
    if driver != "s3":
        raise RuntimeError("invalid_document_storage_driver")

    region = required(environment, "S3_REGION")
    bucket = required(environment, "S3_BUCKET")
    access_key = required(environment, "S3_ACCESS_KEY_ID")
    secret_key = required(environment, "S3_SECRET_ACCESS_KEY")
    endpoint = environment.get("S3_ENDPOINT") or None
    if not valid_region(region) or not valid_bucket(bucket):
        raise RuntimeError("invalid_s3_configuration")
    if not 1 <= len(access_key) <= 256 or not 8 <= len(secret_key) <= 512:
        raise RuntimeError("invalid_s3_configuration")
    if endpoint is not None and not valid_endpoint(endpoint):
        raise RuntimeError("invalid_s3_configuration")

    client = boto3.client(
        "s3",
        region_name=region,
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )
    return S3ObjectStorage(client=client, bucket=bucket)


def validate_object_key(object_key: str) -> list[str]:
    segments = object_key.split("/")
    if (
        not object_key
        or object_key.startswith("/")
        or any(not segment or segment in {".", ".."} for segment in segments)
    ):
        raise ValueError("invalid_object_key")
    return segments


def required(environment: Mapping[str, str], name: str) -> str:
    value = environment.get(name, "")
    if not value:
        raise RuntimeError(f"missing_{name.lower()}")
    return value


def valid_bucket(value: str) -> bool:
    import re

    return bool(re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", value)) and ".." not in value


def valid_region(value: str) -> bool:
    import re

    return bool(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", value))


def valid_endpoint(value: str) -> bool:
    parsed = urlparse(value)
    return (
        parsed.scheme in {"http", "https"}
        and bool(parsed.hostname)
        and not parsed.username
        and not parsed.password
        and parsed.path in {"", "/"}
        and not parsed.query
        and not parsed.fragment
    )
