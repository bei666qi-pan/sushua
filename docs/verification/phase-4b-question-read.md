# Phase 4b：题目读取与来源证据 API

## 范围

本切片在 `grounded_generation` Feature Flag 后新增两个只读 v1 端点：

- `GET /api/v1/workspaces/{workspace_id}/questions`：仅按 `created_at,id` 游标返回当前、非归档的
  `QuestionVersion` 组装视图；不回传旧版本或归档题。
- `GET /api/v1/question-versions/{question_version_id}/sources`：返回到
  DocumentVersion、Page、Block 与 `source_hash` 的精确证据绑定。

`QuestionReadModule` 是读取与 RLS 的唯一 seam；路由只负责 flag、身份和 HTTP 协议。公开响应
一律使用 v1 既有的下划线字段名。Flag 默认关闭时，两条路由在不初始化 Auth 或 PostgreSQL 的情况下
返回 404。

本切片不创建或修改题目、不调用模型、不打开 Feature Flag，也不改变旧 `/api/banks*` 或 `/b/[slug]`。

## 本地验证（2026-09-04）

- `test/question-read-api.test.ts` 先确认缺失 QuestionVersion 来源路由会失败，再覆盖真实 PostgreSQL：
  当前版本与归档过滤、稳定游标、成员访问、A/B 租户防枚举 404、来源的
  DocumentVersion/Page/Block/source hash 精确绑定，以及无效参数的 400。
- `test/question-read-disabled.test.ts` 确认默认关闭时两条路由均不需要 Auth 或 PostgreSQL 配置。
- 通过隔离 PostgreSQL、Redis、ClamAV、Document Service 和 Docling 执行的
  `npm run ci:verify` 退出码为 0，覆盖完整测试、两张只读非 root 文档镜像契约、类型检查、lint、
  生产构建及审计。
- npm 生产依赖审计仅报告 `@xmldom/xmldom` 的一项 moderate 传递依赖公告；没有 high/critical。
  Python 审计无已知漏洞；本地内部包因未发布到 PyPI 被标记为无法审计，Docling 审计沿用已记录的
  Darwin `CVE-2026-9856` 临时忽略。

尚未推送 GitHub、同步 Gitee 或部署 Coolify；线上状态没有变化。
