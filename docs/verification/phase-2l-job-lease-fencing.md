# Phase 2L：数据库租约、attempt fencing 与执行中取消

日期：2026-09-02

## 本增量交付

- `claim_job_v2` 只使用 PostgreSQL `clock_timestamp()` 判断 `run_after`、租约过期与新 `timeout_at`，不再信任 Worker 时钟。
- `heartbeat_job_v1` 续租并返回 `active / cancel_requested / lease_lost`；共享 Worker 最长每 5 秒检查一次。
- `transition_job_v2` 要求当前 attempt，所有进度、重试、成功、失败、死信与取消写入均受 fencing 保护。
- 扫描和文档解析领域写入在同一事务内调用 `assert_job_attempt_v1` 并持有 Job 行锁，不能绕过 Job 状态机写入旧结果。
- 执行中取消会主动中止 Handler 的 `AbortSignal`，当前 attempt 再把持久 Job 收敛为 `cancelled`。

## 安全与发布边界

- Redis 仍只负责投递；Workspace、resource、attempt、取消和终态继续以 PostgreSQL 为准。
- 心跳错误会中止当前 Handler，不会在失去数据库控制面时继续处理私有文件。
- 本增量不启用上传、OCR、扫描件或照片入口；原生 PDF 仍受既有双重默认关闭门禁约束。
- MarkItDown 继续作为轻量 Office/HTML fallback；Docling 继续位于独立 Debian slim 文档镜像。文档镜像 OS 层 HIGH/CRITICAL 继续完整扫描和披露但不阻断，Python 应用依赖审计仍阻断。

## 验证合同

- 污染 Worker 时钟到 2099 年，领取和续租时间仍落在真实数据库时间窗口。
- attempt 1 过期、attempt 2 重新领取后，attempt 1 的心跳、Job 写入、扫描和解析状态写入均被拒绝。
- 真实 PostgreSQL + Redis 中，运行中的 Handler 收到用户取消后观察到 `AbortSignal.aborted`，Job 进入 `cancelled`。
- Worker、Document Service、Docling、ClamAV 与既有上传/解析因果链必须在完整 `ci:verify` 中无回归。
