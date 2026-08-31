# ADR 0001: Workspace 与 Learner 作为新领域边界

- 状态：Accepted
- 日期：2026-08-31

## 背景

旧模型以 Bank 聚合题目，以浏览器 owner key 和 localStorage 保存所有权及学习状态。该模型无法同时承载私有资料、跨设备学习记录和登录认领，也无法形成稳定的数据库租户边界。

## 决定

- 新内容聚合根为 Learning Workspace，`workspace_id` 是租户边界。
- Learner 是游客和注册用户共用的稳定学习身份。
- 登录认领绑定现有 Learner，不通过重写个人记录迁移身份。
- Bank 仅保留为旧 `/b/[slug]` 的兼容投影。

## 结果

- 新表、对象键、缓存和后台任务必须带 Workspace 边界。
- Workspace 的公开或分享状态不自动公开 Learner 的作答、错题、掌握度和复习记录。
- 迁移需要 legacy mapping 和可回滚的兼容 Adapter。
