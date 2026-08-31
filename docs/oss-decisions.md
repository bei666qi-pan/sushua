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

生产审计为 0 vulnerabilities。Drizzle Kit 会带入未使用的旧 esbuild loader，因此本增量不安装它；migration 由带 SHA 校验的 SQL runner 执行。

## Review policy

- npm 包全部精确固定；lockfile 由 `npm ci` 验证可复现。
- GitHub Actions 固定到完整 commit SHA，工具自身再固定版本。
- npm audit、Trivy 或 Grype 的 HIGH/CRITICAL 均阻断；例外需要用户明确批准并在 7 天内到期。
- 新核心进程依赖不得使用 AGPL、SSPL、BSL、非商业或来源不明许可。
