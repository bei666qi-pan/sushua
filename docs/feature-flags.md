# Feature Flags

所有新能力在 `src/lib/feature-flags.ts` 统一登记，默认关闭。环境变量格式为 `FEATURE_<FLAG_NAME_UPPERCASE>`，只有 `1`、`true`、`yes`、`on`（大小写不敏感）可开启；空值和未知值均失败关闭。

Phase 0 不在页面、API 或数据库中消费这些开关，因此不会改变线上行为。后续每个入口都必须同时定义：

- 开启范围和负责人；
- 依赖的迁移版本；
- 关闭后的读写行为；
- 已生成数据的保留策略；
- 灰度与回滚验证。
