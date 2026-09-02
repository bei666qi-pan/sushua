from __future__ import annotations

import argparse
import shutil
from hashlib import sha256
from pathlib import Path

MODEL_REPOSITORY = "docling-project/docling-layout-heron"
MODEL_REVISION = "8f39ad3c0b4c58e9c2d2c84a38465abf757272d8"
MODEL_DIRECTORY_NAME = "docling-project--docling-layout-heron"
MODEL_FILES: dict[str, tuple[int, str]] = {
    ".gitattributes": (
        1519,
        "11ad7efa24975ee4b0c3c3a38ed18737f0658a5f75a0a96787b576a78a023361",
    ),
    "README.md": (
        3219,
        "175700839bc7808eac6af1d0c23e4f483606ab2276fe01122f4093e61a1a65b6",
    ),
    "config.json": (
        3268,
        "fdea30805ce2f5666b147fca941dcdd27ad468e27d6ed21902207d3da056a97d",
    ),
    "docling_heron_400.png": (
        96925,
        "e7f78610372b32a7938e480d2c7fa1c3037ee170bd82282a5bd026232f6e6f9e",
    ),
    "model.safetensors": (
        171658996,
        "00333a43451945aaf89db8ca9c0a17e75d1537c17db60fdb91aa95f4c7929e0c",
    ),
    "preprocessor_config.json": (
        444,
        "cd38cd59999e7a95d68e487fbe5132df3d4e5c32a0836add57e6126ba0c4eaf1",
    ),
}


def validated_artifacts_path(value: str | Path | None) -> Path | None:
    if value is None:
        return None
    artifacts_path = Path(value)
    model_path = artifacts_path / MODEL_DIRECTORY_NAME
    if not artifacts_path.is_dir() or not model_path.is_dir():
        return None
    actual_files = {
        str(path.relative_to(model_path))
        for path in model_path.rglob("*")
        if path.is_file() or path.is_symlink()
    }
    if actual_files != set(MODEL_FILES):
        return None
    for relative_path, (expected_size, expected_sha256) in MODEL_FILES.items():
        path = model_path / relative_path
        if path.is_symlink() or path.stat().st_size != expected_size:
            return None
        if _sha256_file(path) != expected_sha256:
            return None
    return artifacts_path


def download_artifacts(output_path: Path) -> None:
    from huggingface_hub import snapshot_download

    model_path = output_path / MODEL_DIRECTORY_NAME
    model_path.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=MODEL_REPOSITORY,
        revision=MODEL_REVISION,
        local_dir=model_path,
        allow_patterns=list(MODEL_FILES),
    )
    cache_path = model_path / ".cache"
    if cache_path.exists():
        shutil.rmtree(cache_path)
    if validated_artifacts_path(output_path) is None:
        raise RuntimeError("docling_model_integrity_mismatch")


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
    download_artifacts(arguments.output)


if __name__ == "__main__":
    main()
