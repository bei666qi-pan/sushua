from __future__ import annotations

import argparse
import shutil
import tarfile
from collections.abc import Mapping
from hashlib import sha256
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

PADDLE_MODEL_FILES: dict[str, tuple[int, str]] = {
    "PP-OCRv5_mobile_det_infer/inference.json": (
        229_777,
        "05feef1acb00aa4cd7362b15f7f501fc4f99d7b1fa73c1c871e0c7b1504b0f5c",
    ),
    "PP-OCRv5_mobile_det_infer/inference.pdiparams": (
        4_692_937,
        "afa1820cb16c1fd0dad589d0f8b389139061c1ef6d68019685fd07be997dda5b",
    ),
    "PP-OCRv5_mobile_det_infer/inference.yml": (
        903,
        "98069072e1b6b37d727fd9d9f11725faa46d6ea0de012f2ed26caea011c37699",
    ),
    "PP-OCRv5_mobile_rec_infer/inference.json": (
        217_724,
        "24587345250c7332d0fc6f9a44e794d078cdaeb64c302fef906f325619de2569",
    ),
    "PP-OCRv5_mobile_rec_infer/inference.pdiparams": (
        16_458_665,
        "2460da90875937c94db97eba74ae3d9e5d4c4c57c42f1f41531c09a26bcc771a",
    ),
    "PP-OCRv5_mobile_rec_infer/inference.yml": (
        148_345,
        "5dfeb2777f6d0db8177d8128a8acfcf6e6276dc4ac73ea3bf0dc06d6a5e85d8e",
    ),
}
PADDLE_MODEL_ARCHIVES = (
    (
        "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/"
        "paddle3.0.0/PP-OCRv5_mobile_det_infer.tar",
        "50446e5d01ac2a73d5319c89513281f6578414c888c602f9af13f93feefffc58",
        "PP-OCRv5_mobile_det_infer/",
    ),
    (
        "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/"
        "paddle3.0.0/PP-OCRv5_mobile_rec_infer.tar",
        "566b9512b34e34a9f0db54d87b51fa5a0b9ed2cf1ab7e49728cc0b8b5a64f414",
        "PP-OCRv5_mobile_rec_infer/",
    ),
)
_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args: object, **_kwargs: object) -> None:
        return None


def validated_paddle_artifacts_path(value: str | Path | None) -> Path | None:
    if value is None:
        return None
    return validate_artifact_manifest(Path(value), PADDLE_MODEL_FILES)


def validate_artifact_manifest(
    root: Path,
    manifest: Mapping[str, tuple[int, str]],
) -> Path | None:
    if not root.is_dir():
        return None
    actual_files = {
        str(path.relative_to(root))
        for path in root.rglob("*")
        if path.is_file() or path.is_symlink()
    }
    if actual_files != set(manifest):
        return None
    for relative_path, (expected_size, expected_sha256) in manifest.items():
        path = root / relative_path
        if path.is_symlink() or path.stat().st_size != expected_size:
            return None
        if _sha256_file(path) != expected_sha256:
            return None
    return root


def extract_verified_archive(
    archive_path: Path,
    output_path: Path,
    *,
    archive_sha256: str,
    manifest: Mapping[str, tuple[int, str]],
) -> None:
    if _sha256_file(archive_path) != archive_sha256:
        raise RuntimeError("paddle_model_archive_integrity_mismatch")
    try:
        with tarfile.open(archive_path, "r:") as archive:
            members = archive.getmembers()
            if any(
                not (member.isfile() or member.isdir())
                or not _safe_archive_path(member.name)
                for member in members
            ):
                raise RuntimeError("paddle_model_archive_invalid")
            files = {member.name: member for member in members if member.isfile()}
            if set(files) != set(manifest):
                raise RuntimeError("paddle_model_archive_invalid")
            if output_path.exists():
                shutil.rmtree(output_path)
            output_path.mkdir(parents=True)
            for relative_path, member in files.items():
                source = archive.extractfile(member)
                if source is None:
                    raise RuntimeError("paddle_model_archive_invalid")
                target = output_path / relative_path
                target.parent.mkdir(parents=True, exist_ok=True)
                with source, target.open("wb") as destination:
                    shutil.copyfileobj(source, destination)
        if validate_artifact_manifest(output_path, manifest) is None:
            raise RuntimeError("paddle_model_integrity_mismatch")
    except Exception:
        shutil.rmtree(output_path, ignore_errors=True)
        raise


def _safe_archive_path(value: str) -> bool:
    path = PurePosixPath(value)
    return bool(value) and not path.is_absolute() and ".." not in path.parts


def download_paddle_artifacts(output_path: Path) -> None:
    if output_path.exists():
        shutil.rmtree(output_path)
    output_path.mkdir(parents=True)
    opener = build_opener(ProxyHandler({}), _RejectRedirects())
    try:
        with TemporaryDirectory(prefix="sushua-paddle-models-") as directory:
            temporary = Path(directory)
            for index, (url, archive_sha256, prefix) in enumerate(PADDLE_MODEL_ARCHIVES):
                archive_path = temporary / f"model-{index}.tar"
                _download(opener, url, archive_path)
                stage = temporary / f"stage-{index}"
                manifest = {
                    path: metadata
                    for path, metadata in PADDLE_MODEL_FILES.items()
                    if path.startswith(prefix)
                }
                extract_verified_archive(
                    archive_path,
                    stage,
                    archive_sha256=archive_sha256,
                    manifest=manifest,
                )
                source_directory = stage / prefix.rstrip("/")
                shutil.move(str(source_directory), output_path / source_directory.name)
        if validated_paddle_artifacts_path(output_path) is None:
            raise RuntimeError("paddle_model_integrity_mismatch")
    except Exception:
        shutil.rmtree(output_path, ignore_errors=True)
        raise


def _download(opener: object, url: str, destination: Path) -> None:
    request = Request(url, headers={"User-Agent": "sushua-model-fetch/1"})
    with opener.open(request, timeout=120) as response, destination.open("wb") as output:  # type: ignore[attr-defined]
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > _MAX_ARCHIVE_BYTES:
                raise RuntimeError("paddle_model_archive_too_large")
            output.write(chunk)


def _sha256_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    download_paddle_artifacts(arguments.output)


if __name__ == "__main__":
    main()
