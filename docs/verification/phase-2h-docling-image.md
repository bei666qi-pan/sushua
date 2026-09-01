# Phase 2h isolated Docling image verification

Date: 2026-09-01

## Scope

- Add a separate, pinned Docling 2.124.0 runtime image.
- Keep it independent from the MarkItDown Document Service environment.
- Use the official CPU wheel index for Torch and Torchvision; do not ship CUDA dependencies.
- Establish real DOCX conversion and malicious ODF regression contracts before adding a production HTTP route.

## TDD evidence

- The initial container contract failed because `services/docling-worker` did not exist.
- The first dependency build revealed that PyPI Torch selected CUDA 13 and several gigabytes of NVIDIA packages.
- Adding Torch and Torchvision as explicit CPU-index dependencies reduced the lock from 125 to 108 packages and removed all NVIDIA, CUDA and Triton packages.

## Fresh local evidence

- Pinned image: Python 3.12.14 slim digest `sha256:e5c9fa26ffb76e11e0f054f30dc2523a2f9693f0c36c0cf1e39b27e152d899fc`.
- Runtime: Docling 2.124.0, Torch 2.13.0+cpu and Torchvision 0.28.0+cpu.
- Final local image size: 412,812,532 bytes.
- Real DOCX conversion passed with `--network none`, read-only root, numeric non-root, all capabilities dropped and no-new-privileges.
- The malicious ODF external image fixture referencing `file:///etc/passwd` did not expose container file contents.
- Trivy 0.74.0 reported 13 HIGH and 3 CRITICAL findings in the Debian base layer and 0 HIGH/CRITICAL Python package findings; no fixed versions were available in the selected base snapshot.
- Grype 0.118.0 completed a second image scan and reported the expected unfixed Debian base findings.
- Syft 1.51.1 generated valid CycloneDX (1.4 MB) and SPDX 2.3 (3.2 MB) SBOMs.

This image is not yet wired into the production parse route and is not deployment evidence.
