from __future__ import annotations

import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Protocol


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
        segments = object_key.split("/")
        if (
            not object_key
            or object_key.startswith("/")
            or any(not segment or segment in {".", ".."} for segment in segments)
        ):
            raise ValueError("invalid_object_key")
        candidate = self._root.joinpath(*segments).resolve(strict=False)
        if not candidate.is_relative_to(self._root):
            raise ValueError("invalid_object_key")
        return candidate
