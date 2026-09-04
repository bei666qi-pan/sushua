# Phase 4a：题目、概念与来源证据 Schema

## 范围

本迁移建立 Phase 4 生成与质量管线所需的不可变内容事实层：

- `concepts` 与 `concept_sources`：概念及其 Document Block 证据。
- `questions`：稳定题目身份，包含同 Workspace 的变式父题关系和当前版本指针。
- `question_versions`：不可变题干、选项、答案、rubric、难度、认知层级和生成元数据。
- `question_sources`：QuestionVersion 到 DocumentVersion/Page/Block 的定位证据，区分
  `supports_stem`、`supports_answer` 与 `supports_explanation`。
- `question_concepts`：题目版本到概念的带权关系，且每个版本最多一个主概念。

所有表都带 Workspace 复合外键、RLS 与索引。来源表同时引用 Page 和 Block 的同一
DocumentVersion，Block 必须属于该 Page，不能用同 Workspace 的不同页内容伪造定位。
其 `source_hash` 也必须与引用 Block 的证据 hash 一致，避免重解析后把旧引用静默挂到新内容。
QuestionVersion、QuestionSource 和 QuestionConcept 没有更新或删除 policy；题目编辑必须
创建新版本，再由受限题目路径切换 `current_version_id`。

## 本地验证（2026-09-04）

- `test/question-schema.test.ts` 先在无迁移状态下确认表不存在，再新增迁移后通过。
- 真实 PostgreSQL 测试覆盖同租户题目/概念/来源写入、stem 与 answer 双证据、跨 Workspace
  Block 拒绝、同资料跨页 Block 拒绝、source hash 漂移拒绝、跨 Workspace 父题拒绝、成员可见性和版本不可变。
- 隔离 PostgreSQL、Redis、ClamAV、Document Service 和 Docling 依赖下，
  `npm run test:integration` 退出码为 0。
- `npm run test:unit`、`npm run typecheck`、`npm run lint`、`npm run build` 与
  `git diff --check` 均退出码为 0。
- `npm run audit` 已完成；生产依赖没有 high/critical，仅有一项
  `@xmldom/xmldom` 的 moderate 传递依赖公告。它未被标记为 P0 发布阻断，仍需在
  上游可安全升级时处理。

本切片不创建出题 API、不调用模型、不改变现有题库路径，也不部署线上。
