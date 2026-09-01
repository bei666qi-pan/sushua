# Third-party notices

本项目使用或在交付流程中调用以下第三方软件。该清单覆盖 Phase 0 直接依赖和 CI 工具；完整传递依赖由每次 CI 生成的 CycloneDX/SPDX SBOM 记录。

| 软件 | 固定版本 | 许可证 | 上游 |
|---|---:|---|---|
| Next.js | 15.5.24 | MIT | https://github.com/vercel/next.js |
| React / React DOM | 19.2.7 | MIT | https://github.com/facebook/react |
| Tailwind CSS / Tailwind PostCSS | 4.3.2 | MIT | https://github.com/tailwindlabs/tailwindcss |
| Mammoth | 1.12.0 | BSD-2-Clause | https://github.com/mwilliamson/mammoth.js |
| pdf-parse | 1.1.1 | MIT | https://gitlab.com/autokent/pdf-parse |
| TypeScript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| tsx | 4.22.4 | MIT | https://github.com/privatenumber/tsx |
| ESLint | 9.39.2 | MIT | https://github.com/eslint/eslint |
| Trivy | 0.74.0 | Apache-2.0 | https://github.com/aquasecurity/trivy |
| Syft | 1.51.1 | Apache-2.0 | https://github.com/anchore/syft |
| Grype | 0.118.0 | Apache-2.0 | https://github.com/anchore/grype |
| Gitleaks | 8.30.1 | MIT | https://github.com/gitleaks/gitleaks |
| Node.js | 24 Alpine image digest `sha256:e67514e…a7a4eaf` | MIT | https://github.com/nodejs/node |
| Alpine Linux | 3.24 image packages | package-specific open source licenses | https://www.alpinelinux.org |
| OpenSSL | 3.5.8-r0 Alpine packages | Apache-2.0 | https://www.openssl.org |
| Better Auth | 1.7.2 | MIT | https://github.com/better-auth/better-auth |
| Drizzle ORM | 0.45.2 | Apache-2.0 | https://github.com/drizzle-team/drizzle-orm |
| node-postgres | 8.23.0 | MIT | https://github.com/brianc/node-postgres |
| uuid | 14.0.2 | MIT | https://github.com/uuidjs/uuid |
| pgvector | 0.8.6 | PostgreSQL License | https://github.com/pgvector/pgvector |
| Nodemailer | 9.1.0 | MIT-0 | https://github.com/nodemailer/nodemailer |
| AWS SDK for JavaScript v3 (`client-s3`, `s3-request-presigner`) | 3.1122.0 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| BullMQ | 6.3.3 | MIT | https://github.com/taskforcesh/bullmq |
| node-redis | 6.2.1 | MIT | https://github.com/redis/node-redis |
| Redis container | 8.2.1 Alpine image digest `sha256:987c376c…1593232` | RSALv2 / SSPLv1 / AGPLv3 tri-license; bundled components vary | https://hub.docker.com/_/redis |
| ClamAV container | 1.5.4 image index digest `sha256:f0954d6790…85f591` | GPL-2.0-only；独立网络进程 | https://github.com/Cisco-Talos/clamav |
| FastAPI | 0.141.1 | MIT | https://github.com/fastapi/fastapi |
| Uvicorn | 0.52.4 | BSD-3-Clause | https://github.com/encode/uvicorn |
| uv | 0.12.8 | Apache-2.0 | https://github.com/astral-sh/uv |
| Ruff | 0.16.5 | MIT | https://github.com/astral-sh/ruff |
| mypy | 2.3.1 | MIT | https://github.com/python/mypy |
| pip-audit | 2.10.1 | Apache-2.0 | https://github.com/pypa/pip-audit |
| boto3 | 1.43.85 | Apache-2.0 | https://github.com/boto/boto3 |
| Moto（仅测试） | 5.2.3 | Apache-2.0 | https://github.com/getmoto/moto |
| MarkItDown | 0.1.7 | MIT | https://github.com/microsoft/markitdown |
| Magika | 0.6.3 | Apache-2.0 | https://github.com/google/magika |
| ONNX Runtime | 1.20.1 | MIT | https://github.com/microsoft/onnxruntime |
| Python | 3.13.15 slim image digest `sha256:881d8073…a6a6ec2` | PSF-2.0；Debian 组件按各包许可 | https://hub.docker.com/_/python |
| Docling | 2.124.0 | MIT | https://github.com/docling-project/docling |
| PyTorch CPU | 2.13.0+cpu | BSD-3-Clause | https://github.com/pytorch/pytorch |
| Torchvision CPU | 0.28.0+cpu | BSD-3-Clause | https://github.com/pytorch/vision |
| Python | 3.12.14 slim image digest `sha256:e5c9fa26…2d899fc` | PSF-2.0；Debian 组件按各包许可 | https://hub.docker.com/_/python |

各软件版权归其贡献者所有，并按上游许可证提供。本文件不改变任何上游许可证条款。
