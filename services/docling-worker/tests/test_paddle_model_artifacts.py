from __future__ import annotations

import io
import tarfile
import tempfile
import unittest
from hashlib import sha256
from pathlib import Path

from docling_service.paddle_model_artifacts import (
    extract_verified_archive,
    validate_artifact_manifest,
)


class PaddleModelArtifactTests(unittest.TestCase):
    def test_verified_archive_rejects_a_manifest_path_that_escapes_the_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "model.tar"
            content = b"must-not-escape"
            with tarfile.open(archive, "w") as bundle:
                info = tarfile.TarInfo("../escaped.bin")
                info.size = len(content)
                bundle.addfile(info, io.BytesIO(content))
            manifest = {
                "../escaped.bin": (len(content), sha256(content).hexdigest())
            }
            output = root / "models"

            with self.assertRaisesRegex(
                RuntimeError, "paddle_model_archive_invalid"
            ):
                extract_verified_archive(
                    archive,
                    output,
                    archive_sha256=sha256(archive.read_bytes()).hexdigest(),
                    manifest=manifest,
                )

            self.assertFalse((root / "escaped.bin").exists())
            self.assertFalse(output.exists())

    def test_verified_archive_extracts_only_the_manifest_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "model.tar"
            content = b"fixed-model-content"
            with tarfile.open(archive, "w") as bundle:
                info = tarfile.TarInfo("detector/inference.json")
                info.size = len(content)
                bundle.addfile(info, io.BytesIO(content))
            manifest = {
                "detector/inference.json": (len(content), sha256(content).hexdigest())
            }
            output = root / "models"

            extract_verified_archive(
                archive,
                output,
                archive_sha256=sha256(archive.read_bytes()).hexdigest(),
                manifest=manifest,
            )

            self.assertEqual((output / "detector/inference.json").read_bytes(), content)
            self.assertEqual(validate_artifact_manifest(output, manifest), output)

    def test_manifest_requires_the_exact_regular_file_set(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "detector"
            model.mkdir()
            content = b"fixed-model-content"
            (model / "inference.json").write_bytes(content)
            manifest = {
                "detector/inference.json": (len(content), sha256(content).hexdigest())
            }

            self.assertEqual(validate_artifact_manifest(root, manifest), root)

            (model / "unexpected.bin").write_bytes(b"must not be accepted")

            self.assertIsNone(validate_artifact_manifest(root, manifest))

    def test_manifest_rejects_symlinks_even_when_target_content_matches(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target.json"
            target.write_bytes(b"fixed-model-content")
            model = root / "detector"
            model.mkdir()
            (model / "inference.json").symlink_to(target)
            manifest = {
                "detector/inference.json": (
                    len(b"fixed-model-content"),
                    sha256(b"fixed-model-content").hexdigest(),
                )
            }

            self.assertIsNone(validate_artifact_manifest(root, manifest))
