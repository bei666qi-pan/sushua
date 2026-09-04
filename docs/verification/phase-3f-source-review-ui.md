# Phase 3f：来源核对界面壳层

## 范围

新增受 `FEATURE_SOURCE_REVIEW` 保护的动态页面：

`/source-review/{documentVersionId}`

它消费既有的 Page、Block 与 Block source API，提供页码切换、低置信内容过滤、
Block 选择、引用摘录、五分钟原件链接和可重试错误状态。页面不会自行解析文件、
不会改变 Block 或 DocumentVersion，也不绕过现有 RLS/预签名 URL 边界。

桌面端保留左侧原文预览与右侧结构化内容；移动端将原文预览放进全屏抽屉，避免把
桌面双栏等比压缩到小屏幕。深层页面始终提供“返回资料库”入口。

## 默认安全状态

- `source_review` 默认关闭，页面返回 404；旧上传和题库路径不变。
- 客户端只读取标准 v1 JSON envelope；网络、非 JSON 与结构异常都会显示可重试错误，
  不会伪装为空资料页。
- 原件地址来自既有的短时 `GET /api/v1/blocks/{id}/source` 返回值；预览链接额外使用
  `#page=N` 请求浏览器定位 PDF 页，且不持久化或公开该地址。
- iframe 使用空 sandbox 与 `no-referrer`，外部原件不获得主站上下文。

## 本地验证（2026-09-04）

新增测试覆盖：

- `test/source-review-client.test.ts`：页/Block 请求路径、置信度与类型参数、可重试来源错误。
- `test/source-review-panel.test.tsx`：初始读取状态、返回资料库入口、移动端抽屉的 dialog
  语义、页码锚点和原件预览标题。

本地浏览器验证（开发服务）确认：深层页以既有纸张/松绿色系统渲染，来源服务不可用时
出现“来源读取暂时不可用”及“重新读取”，不会将错误表示为成功或空资料。

- 隔离的 PostgreSQL、Redis 与 ClamAV 依赖就绪后，完整 `npm run test` 退出码为 0；其中
  包含真实 Docling、对象存储、RLS、来源定位 API、修订 API 与 ClamAV 链路。
- `npm run build`、`npm run typecheck`、`npm run lint`、`npm run test:golden` 和
  `git diff --check` 均退出为 0。
- `npm run audit` 在本机等待外部 npm 注册表 90 秒后仍未返回，因此没有审计结论，也不将其
  标记为通过；在推送或合并前须取得可复现的审计结果。

本文件不将本地开发服务、测试依赖或 Feature Flag 的关闭状态表述为上线。尚未提交、推送、
触发 CI 或部署到线上。
