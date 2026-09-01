# OSS decisions

本页是 2026-08-31 的 Phase 0 实时快照。Star 是候选功能相符时的首要排序信号，但还必须同时满足维护活跃、当前 Codex/Node/CI 兼容和请求范围内的安全要求。每个后续 PR 重新核查并追加日期记录。

## Runtime and build baseline

| 组件 | 快照 | 许可 | 决定与安全结论 |
|---|---|---|---|
| Next.js | 142,037 Star；仓库当日活跃；上游最新 v16.3.3 | MIT | 为避免 Phase 0 改变框架主版本，固定 15.5.24。生产树将 PostCSS 固定 8.5.23、NanoID 3.3.18、Sharp 0.35.3；本地 `npm audit --omit=dev` 为 0。Phase 1 前继续跟踪 15.x advisory。 |
| React | 248,338 Star；v19.2.8；2026-08-28 活跃 | MIT | 固定现有兼容线 19.2.7，与 Next 15.5.24 peer range 相容。 |
| Tailwind CSS | 97,406 Star；v4.3.3；当日活跃 | MIT | 固定已验证的 4.3.2，不在安全基线 PR 改视觉。 |
| Mammoth | 6,291 Star；仓库 2026-08-28 活跃 | BSD-2-Clause | 固定已解析到的 1.12.0，作为 DOCX 旧路径；Phase 2 由 DocumentParser Adapter 收口。 |
| pdf-parse | GitLab 69 Star；最近活动 2025-10-24；npm 1.1.1 | MIT | 不是本 PR 新选型，只为保持旧 PDF 路径固定 1.1.1。维护和能力均不足，Phase 2 由 Docling 路径替代，迁移前不删除。 |
| TypeScript | 110,806 Star；v7.0.2；当日活跃 | Apache-2.0 | 固定当前已验证的 5.9.3，避免基线 PR 跨到新的主版本。 |
| tsx | 12,124 Star；v4.23.13；2026-08-30 活跃 | MIT | 固定 4.22.4，继续运行现有轻量测试脚本。 |
| ESLint | 27,496 Star；v10.9.1；当日活跃 | MIT | Next 15.5.24 的配置 peer range 最高为 ESLint 9，故固定兼容版 9.39.2。它是开发门禁，不进入生产镜像；升级 Next 时一并迁移 ESLint 10。 |
| Node.js / Alpine | Node 24 Alpine digest `sha256:e67514e…a7a4eaf` | Node.js MIT；Alpine 组件按各包许可 | 镜像扫描发现基础快照的 OpenSSL 3.5.7 high，运行层精确升级到 3.5.8-r0；移除运行时不需要且带入 high 的全局 npm。修复后 Trivy 与 Grype 均为 0 HIGH/CRITICAL。 |

## CI security tooling

| 组件 | 快照 | 许可 | 集成决定 |
|---|---|---|---|
| Trivy | 37,713 Star；v0.74.0；2026-08-28 活跃 | Apache-2.0 | 固定 v0.74.0，扫描文件系统与最终镜像；HIGH/CRITICAL 阻断。上游存在历史公告，因此结果按所选版本和扫描数据库判断，不以公告数量代替影响分析。 |
| Syft | 9,484 Star；v1.51.1；2026-08-29 活跃 | Apache-2.0 | 固定 v1.51.1，生成 CycloneDX JSON 与 SPDX JSON。 |
| Grype | 12,809 Star；v0.118.0；2026-08-28 活跃 | Apache-2.0 | 固定 v0.118.0，对镜像二次扫描；HIGH/CRITICAL 阻断。 |
| Gitleaks | 29,032 Star；v8.30.1；2026-08-26 活跃 | MIT | 直接使用固定版本 CLI，不采用带独立商业条款的 Gitleaks Action。扫描完整 Git 历史。 |
| Playwright | 95,416 Star；1.62.1；当日活跃 | Apache-2.0 | 选定为后续真实浏览器 E2E；Phase 0 不安装浏览器或伪造空 E2E 通过。 |
| Promptfoo | 24,693 Star；0.122.2；当日活跃 | MIT | 选定为 Phase 4 AI Eval；Phase 0 只建立不调用模型的 Golden Corpus 接口。 |

## Phase 1 data and identity snapshot

2026-08-31 复核：

| 组件 | 快照 | 许可 | 决定与安全结论 |
|---|---|---|---|
| Better Auth | 29,772 Star；v1.7.2；2026-08-30 活跃；2026-08-31 复核 | MIT | 精确固定 1.7.2。邮箱 OTP 仅启用哈希存储、5 分钟有效期、3 次尝试和每分钟 3 次限流；organization、SSO、SCIM、密码注册和恢复均关闭。当前仍覆盖 1.7.2 的 high 公告 GHSA-fmh4-wcc4-5jm3 只在启用 organization 邀请且允许未验证邮箱会话等条件同时成立时受影响，本配置不启用该插件且 OTP 登录验证邮箱。上游 Adapter 默认会把持久化 token 返回给 cookie，因此采用 ADR 0003 的哈希 Adapter，并用真实 PostgreSQL 验证发送 OTP→验证→建会话→读取→登出因果链。 |
| Drizzle ORM | 35,639 Star；0.45.2；2026-08-28 活跃 | Apache-2.0 | 精确固定已修复的 0.45.2；Schema 使用 Drizzle 类型，RLS 与角色仍由双审 SQL migration 管理。 |
| pgvector | 22,836 Star；0.8.6；2026-08-20 活跃 | PostgreSQL License | 测试容器固定 `0.8.6-pg17` digest；Phase 1 只验证 extension 和租户 Schema，不建立 HNSW。 |
| node-postgres | 13,199 Star；8.23.0；2026-08-18 活跃 | MIT | 用于 transaction-mode 连接与参数化 `set_config`；每次请求必须在同一事务内设置租户上下文。 |
| uuid | 15,321 Star；14.0.2；2026-08-18 活跃 | MIT | 应用侧生成 UUIDv7，避免数据库往返和随机 UUID 索引离散。 |
| Nodemailer | 17,663 Star；v9.1.0；2026-08-31 发布并活跃 | MIT-0 | 在 `guest_claim` Flag 开启时通过受控 `SMTP_URL` 投递邮箱 OTP；精确固定 9.1.0。两个已发布 high 公告分别影响 ≤9.0.0 和 ≤7.0.10，当前版本均已修复。邮件只含登录验证码和有效期，不记录 OTP 或 SMTP 凭证。 |

生产审计为 0 vulnerabilities。Drizzle Kit 会带入未使用的旧 esbuild loader，因此本增量不安装它；migration 由带 SHA 校验的 SQL runner 执行。

## Phase 2 storage snapshot

2026-09-01 复核：

| 组件 | 快照 | 许可 | 决定与安全结论 |
|---|---|---|---|
| AWS SDK for JavaScript v3 | 3,664 Star；2026-08-31 活跃；v3.1122.0 当日发布 | Apache-2.0 | 精确固定 `@aws-sdk/client-s3` 和 `@aws-sdk/s3-request-presigner` 3.1122.0。GitHub 当前无 high/critical repository advisory，本地生产依赖审计为 0。仅用于 5 分钟 S3 multipart 预签名、完成/取消、HeadObject、短期读 URL 和批量删除；对象键必须位于 `tenant/{workspace_id}/...`，元数据只携带 SHA256，不把原文或密钥进入日志。代替：若 S3 multipart 无法满足断点续传，再评估 tusd/Tus；P0 不引入 AGPL MinIO 核心依赖。 |

## Phase 2 queue snapshot

2026-09-01 复核：

| 组件 | 快照 | 许可 | 决定与安全结论 |
|---|---|---|---|
| BullMQ | 9,356 Star；v6.3.3；2026-08-31 活跃 | MIT | 精确固定 6.3.3。GitHub 当前无已发布 high/critical repository advisory；PostgreSQL `jobs` 继续作为事实源，Redis 只保存经过 Schema 校验的小型 Job Envelope。BullMQ `jobId` 固定为持久 Job UUID，因此重复投递不会创建第二个队列任务。替代：若未来需要跨语言持久调度，再基于实际吞吐和恢复数据评估专用工作流引擎。 |
| node-redis | 17,573 Star；v6.2.1；2026-08-31 活跃 | MIT | 精确固定 6.2.1。GitHub 当前无已发布 high/critical repository advisory。符合 Star 首要排序规则，Star 高于兼容候选 ioredis；BullMQ 6 提供 `createNodeRedisClient` 官方适配入口。Dispatcher 显式拥有并关闭原始连接，配置仅接受 `redis:`/`rediss:` URL，日志与 Job payload 均不包含连接凭证或原文。 |

## Phase 2 file scanning snapshot

2026-09-01 复核：

| 组件 | 快照 | 许可 | 决定与安全结论 |
|---|---|---|---|
| ClamAV | 7,190 Star；clamav-1.5.4 于 2026-08-07 发布；2026-08-27 活跃 | GPL-2.0-only | 固定官方容器索引 digest `sha256:f0954d679017eb6d48221e2b2be3ac5457bf278a844f39b672376f55a085f591`，仅作为独立网络服务调用，不复制或链接 GPL 代码进产品核心。GitHub 当前无已发布 repository advisory；CI 仍扫描容器中的 OS 和应用组件，HIGH/CRITICAL 阻断。真实 TCP 集成测试要求普通字节流为 clean、标准 EICAR 为 infected，错误或畸形响应一律失败关闭。该上游镜像目前只有 `linux/amd64`，CI/生产按 amd64 运行，Apple Silicon 本地验证需显式使用 Docker amd64 仿真。若未来更换扫描引擎，只替换 `ClamAvAdapter` 边界，不改变业务扫描状态协议。 |

## Phase 2 Document Service snapshot

2026-09-01 复核：

| 组件 | 快照 | 许可 | 决定与安全结论 |
|---|---|---|---|
| FastAPI | 101,983 Star；0.141.1 于 2026-07-29 发布；最后提交 2026-08-26 | MIT | 精确固定 0.141.1，作为仅内网可达的 Document Service HTTP 层。GitHub 当前唯一仓库公告为影响 `<0.65.2` 的 medium，所选版本不受影响。首个增量只暴露最小 live/ready 与带 Bearer token 的 `/v1/parse`，关闭 OpenAPI/Swagger，不记录正文或 token。 |
| Uvicorn | 10,939 Star；0.52.4 于 2026-08-19 发布；最后提交 2026-08-30 | BSD-3-Clause | 精确固定 0.52.4，作为 FastAPI ASGI Server。GitHub 当前无 repository advisory。服务通过显式内部地址启动；生产容器、S3 Adapter 和资源限制将在独立增量验证，不能把本 PR 的本地对象 Adapter 视为生产部署。 |
| Docling | 65,827 Star；2.124.0 于 2026-08-31 发布；最后提交 2026-08-31 | MIT | 本节所记首个 Document Service PR 未安装；2026-09-01 的独立镜像决策见下方增量复核。 |
| MarkItDown | 177,441 Star；0.1.7 于 2026-07-29 发布；最后提交 2026-08-31 | MIT | 本节所记首个 Document Service PR 未安装；2026-09-01 的后续 Adapter 决策见下方增量复核。 |
| uv | 89,292 Star；0.12.8 于 2026-08-31 发布；最后提交 2026-09-01 | Apache-2.0 | CI 工具精确固定 0.12.8；`uv.lock` 保存完整版本、文件 URL 与 SHA256，`--frozen` 禁止门禁期间改锁。已发布 medium 均影响 `<0.11.15` 等旧版本，所选版本不受影响。 |
| Ruff | 49,415 Star；0.16.5 于 2026-08-27 发布；最后提交 2026-08-31 | MIT | 开发门禁精确固定 0.16.5，检查 Document Service；GitHub 当前无 repository advisory。 |
| mypy | 20,624 Star；2.3.1 于 2026-08-15 发布；最后提交 2026-09-01 | MIT | 开发门禁精确固定 2.3.1 并启用 strict；GitHub 当前无 repository advisory。 |
| pip-audit | 1,359 Star；2.10.1 于 2026-06-10 发布；最后提交 2026-08-31 | Apache-2.0 | 虽低于大型运行时项目，但它是 PyPA 官方安全门禁工具而非产品能力；精确固定 2.10.1，审计锁定后的 Python 环境。GitHub 当前无 repository advisory。 |

2026-09-01 S3 与容器增量复核：

| 组件 | 快照 | 许可 | 决定与安全结论 |
|---|---|---|---|
| boto3 | 9,893 Star；PyPI 1.43.85 于 2026-08-31 发布；最后提交 2026-08-31 | Apache-2.0 | 精确固定 1.43.85，作为 Document Service 的生产 S3-compatible Adapter。GitHub 当前无 repository advisory。Adapter 强制 SigV4、显式凭证、受限 endpoint/region/bucket 配置和对象键校验；SDK 异常只映射为安全错误码，不把响应或凭证写入日志。 |
| Moto | 8,637 Star；5.2.3 于 2026-08-22 发布；最后提交 2026-08-28 | Apache-2.0 | 只作为开发依赖，精确固定 `moto[server]` 5.2.3。通过真实 HTTP 与 SigV4 覆盖 boto3 读写合同，但不把模拟服务当生产 S3 可用性证据。GitHub 当前无 repository advisory。 |
| uv container | 89,292 Star；0.12.8 | Apache-2.0 | 构建阶段只从官方多架构镜像 digest `sha256:d1cbaead…feb23a` 复制 uv；运行镜像不携带 uv。原计划 Python 3.11 slim digest 在 2026-09-01 的 Trivy 0.74.0 数据库中出现 19 个 Debian HIGH/CRITICAL；Python 3.11 Alpine 虽清除 OS 问题，Grype 0.118.0 仍报告 Python 3.11.16 二进制 3 个 HIGH。故在项目既有 `>=3.11,<3.15` 范围内改用 Trivy/Grype 均无 HIGH/CRITICAL 的 Python 3.13 Alpine digest `sha256:62e80a1f…f2cc7`，并从最终层移除 pip/setuptools/wheel 等构建工具。最终镜像以数值 UID/GID 10001 运行，并在 CI 中接受 Trivy、Grype 与双格式 SBOM。 |

2026-09-01 MarkItDown Adapter 增量复核：

| 组件 | 快照 | 许可 | 决定与安全结论 |
|---|---|---|---|
| MarkItDown | 177,477 Star；0.1.7；2026-08-31 活跃 | MIT | 精确固定 `markitdown[docx,pptx,xlsx]` 0.1.7，作为 HTML、DOCX、PPTX 和 XLSX 的简单降级 Adapter。它只接收已通过文件扫描和对象完整性校验的字节流，关闭 plugin，结果统一写入 `sushua.document-ir.v1`；不伪造页面版面真值，bbox 为全页且置信度为 0.8。Adapter 在调用前校验 Office ZIP 核心部件和解压预算，阻止 MarkItDown 对损坏 Office 包的纯文本伪成功回退。GitHub 当前无 repository advisory，`pip-audit` 无已知漏洞。如后续 Docling 可稳定覆盖这些格式，可在 Parser 注册处替换而不改 Web 协议。 |
| Magika / ONNX Runtime | Magika 17,987 Star、0.6.3、Apache-2.0；ONNX Runtime 21,697 Star、1.20.1、MIT；两个上游均在 2026-09-01 复核 | Apache-2.0 / MIT | MarkItDown 0.1.7 无条件引入 Magika，Magika 再引入 ONNX Runtime。ONNX Runtime 1.20.1 无 musllinux wheel，因此文档镜像改为 Python 3.13.15 Debian slim 多架构 digest `sha256:881d8073…a6a6ec2`，不再以 Alpine 为选型目标。两个仓库当前均无 repository advisory，锁定环境 `pip-audit` 无已知漏洞。当日 Trivy 报告 Debian 基础层 13 HIGH / 3 CRITICAL，Grype 也报告 libc、Perl、ncurses、gzip、SQLite 等无上游修复版本的 HIGH/CRITICAL；Python 包扫描为 0。这些系统路径不被服务主动调用，但不等于零风险。根据用户对 MarkItDown 优先的明确取舍，仅 Document Service 镜像的 Trivy/Grype 保留全量报告但改为非阻断；Web、仓库和 ClamAV 门禁不放宽。补偿控制为数值非 root、只读根、drop capabilities、no-new-privileges、无宿主挂载与内网服务边界；每次 PR 重新扫描，出现修复版后恢复阻断。 |

2026-09-01 Docling 独立镜像增量复核：

| 组件 | 快照 | 许可 | 决定与安全结论 |
|---|---|---|---|
| Docling | 65,840 Star；2.124.0；2026-09-01 活跃 | MIT | 精确固定 2.124.0，放入独立 `sushua-docling-worker` 镜像，不与 MarkItDown/FastAPI Document Service 共用 Python 环境。当前版本高于 ODF 外部图像中等风险 GHSA-4xhp-xg4w-8ppm 的修复版 2.120.3，也高于历史 high 的修复点。真实 DOCX 已在无网络、只读根、数值非 root、drop capabilities 和 no-new-privileges 容器中转换；恶意 ODF `draw:image file:///etc/passwd` 回归未读出容器文件。此增量只建立可重现 CPU 运行镜像，尚未将其接入生产解析路由。 |
| PyTorch CPU | PyTorch 102,703 Star；2.13.0+cpu；2026-09-01 活跃 | BSD-3-Clause | Docling 默认 PyPI 解析会在 Linux 拉取 CUDA 13、cuDNN、cuBLAS、NCCL 等数 GB GPU 依赖，与 P0 CPU 基线冲突。将 `torch==2.13.0` 与 `torchvision==0.28.0` 作为显式依赖并绑定官方 CPU wheel 索引，lock 从 125 包降到 108 包，移除全部 NVIDIA/CUDA/Triton 包；最终镜像约 413 MB。当前 PyTorch 仓库 high 公告影响 `<=2.9.1`，critical 影响 `<=2.5.1`，2.13.0 不在范围内。 |

2026-09-01 Docling 内部转换服务增量复核：

- 不新增产品级 OSS 选型；Docling 2.124.0、FastAPI 0.141.1、Uvicorn 0.52.4 和 boto3 1.43.85 沿用上述已复核固定版本。
- Docling 镜像现只暴露内网 `live/ready` 和带服务 token 的 `/v1/convert`；请求只接受租户对象引用、SHA256、长度、MIME 和解析配置，拒绝任意 URL、宿主路径和多余字段。输出为限定键下的 `sushua.docling-output.v1`，尚未接入 Job Worker 的生产解析路由。
- 两个 Python 文档服务共用仓库内 `sushua-document-service-core` 的严格对象引用与 Local/S3 Adapter，不再复制租户键、SigV4、原子写回和安全错误映射逻辑。该包是本仓库内部代码，不是新的第三方依赖。

2026-09-01 Docling Adapter 增量复核：

- 不新增第三方选型；继续使用已固定的 Docling 2.124.0、MarkItDown 0.1.7、FastAPI 0.141.1、Uvicorn 0.52.4 和 boto3 1.43.85。
- Document Service 仅在 `DOCLING_SERVICE_URL` 与独立 token 同时完整配置时注册 Docling Adapter；配置缺失或非法时启动失败关闭。未配置时 DOCX 仍由 MarkItDown 处理，PPTX、XLSX 和 HTML 也继续使用 MarkItDown，不扩大本增量的格式承诺。
- Docling 请求只发送租户对象引用、完整性字段和当前解析配置。Adapter 仅接受精确 HTTP 200，并验证响应大小、严格 Schema、限定输出键、SHA256、文档身份、来源和 parser 版本；拒绝任何 HTTP 重定向并忽略进程代理变量，防止对象引用或内部 token 被带到第二地址；私密正文与 token 不进入日志。
- 当前只将 Docling DOCX 的标题和正文确定性转为一页逻辑 IR，全页 bbox 和 0.85 置信度不伪造版面真值。如果输出含表格、图片、键值或表单结构，在对应 IR 映射实现前显式返回 `docling_unsupported_structure`，不发布部分 IR。
- 该增量将 Docling 接入 Document Service 边界，但仍受现有异步摄取 Feature Flag、Job Worker 和部署配置约束；未部署、未镜像到 Gitee，不是线上能力证据。

## Review policy

- npm 包全部精确固定；lockfile 由 `npm ci` 验证可复现。
- GitHub Actions 固定到完整 commit SHA，工具自身再固定版本。
- npm audit、Trivy 或 Grype 的 HIGH/CRITICAL 默认阻断。例外必须限定到具体镜像、记录扫描结果和补偿控制；用户 2026-09-01 明确批准文档镜像优先实现 MarkItDown/Docling，因此这两个独立 Debian 镜像保留 Trivy/Grype 全量报告但非阻断；仓库、Web 和 ClamAV 仍阻断。
- 新核心进程依赖不得使用 AGPL、SSPL、BSL、非商业或来源不明许可。
