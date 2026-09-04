# Phase 3d：Block 来源定位

## 范围

新增只读接口 `GET /api/v1/blocks/{id}/source`，受既有
`source_review` Feature Flag 保护，默认关闭。此 PR 不改变旧题库路径、
不启用来源核对 UI，也不缓存原文 URL。

## 返回内容

经授权的 Workspace 成员可获得：

- Block 的类型、归一化 bbox、置信度和 `source_hash`；
- 对应 Page 的编号及源尺寸；
- 对应 DocumentVersion 和 Document 身份；
- 最多 1,000 个 Unicode code point 的 Block 文本引用；
- 固定 300 秒有效期的原始文件读取 URL。

对象键、存储 provider 元数据和完整资料正文不会出现在 HTTP 响应或错误中。

## 授权与安全顺序

`BlockSourceModule` 首先在 PostgreSQL RLS 事务中查询未删除的 Block、
Page、DocumentVersion 和 Document；只有成功后才读取已通过扫描的唯一
`original` SourceAsset。随后先用 `StorageAdapter.stat` 验证对象键、大小、
MIME 和 SHA256 与持久化记录一致，再调用 `createReadUrl`。

因此，跨 Workspace 猜测、软删除资料、缺失 SourceAsset、缺失对象或元数据
不一致都不能触发 URL 签发。跨租户与已删除资源均返回防枚举 404；授权资料的
底层对象不可用返回不携带对象信息的可重试 `source_unavailable`。

## 已验证

以下命令在隔离 PostgreSQL、Redis 和 ClamAV 实例下完整通过：

```sh
TEST_DATABASE_URL=<isolated-postgres> \
TEST_REDIS_URL=<isolated-redis> \
TEST_CLAMAV_HOST=<isolated-clamav-host> \
TEST_CLAMAV_PORT=<isolated-clamav-port> \
npm run test
npm run typecheck
npm run lint
npm run build
```

`test/block-source-api.test.ts` 用真实 PostgreSQL RLS 覆盖授权成员、
跨 Workspace 枚举、软删除即时撤权、缺失对象记录、缺失存储对象、固定五分钟
TTL、对象元数据核验和引用截断。
