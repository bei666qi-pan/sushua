# ADR 0003: Better Auth 会话只持久化不可逆哈希

- 状态：Accepted
- 日期：2026-08-31

## 背景

Better Auth 1.7.2 的数据库 Adapter 默认写入原始 session token，并把数据库 `RETURNING` 的 token 继续用于 cookie、刷新和删除。仅把 Drizzle 字段映射到 `token_hash`，或在 database hook 中改写 token，会导致数据库返回的哈希被误当作浏览器凭证。

速刷的安全边界要求数据库和备份中不保存可直接重放的 session token。

## 决定

- 在 Better Auth 与 Drizzle Adapter 之间加入 `withHashedSessionTokens`。
- 所有 session token 写入和查询条件都先执行 SHA-256；数据库列只保存 64 位十六进制哈希。
- 创建会话、按原始 token 精确读取和刷新时，Adapter 只在当前调用栈中恢复原始 token；哈希不能反向恢复，也不能作为 cookie 再次认证。
- 明确禁用 `list-sessions`、`revoke-session`、`revoke-sessions` 和 `revoke-other-sessions`。这些接口把同一个 token 同时当认证凭证和会话列表标识，与不可逆存储模型不相容。
- P0 仍支持当前会话读取和登出；需要多设备会话管理时，另行引入不具认证能力的 session id 作为撤销标识，不放宽哈希边界。

## 结果

- 数据库泄露不会直接得到可重放的 session cookie。
- Better Auth 的密码注册、密码恢复、organization、SSO 和 SCIM 仍不启用。
- 适配层必须跟随 Better Auth 升级运行 contract test 和真实 PostgreSQL 邮箱 OTP 因果链，不能只依赖类型检查。
