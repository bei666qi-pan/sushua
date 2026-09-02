# Gitee 镜像核验限流恢复

日期：2026-09-02

## 根因证据

- GitHub main CI `33639919138` 的 Verify 与 Security 均成功。
- Deploy Production `33640727973` 两次都在镜像步骤失败：`git push` 首次已显示 `9eb14eb..a73f5d8 HEAD -> master`，重跑显示 `Everything up-to-date`；紧接着的单次 `git ls-remote` 均收到 HTTP 429。
- 独立读取确认 GitHub `main` 与 Gitee `master` 都是 `a73f5d81be86899317e987c095384dd7b295bbe7`，说明失败边界是即时远端核验，不是 push 或内容不一致。

## 修复合同

- `.github/workflows/deploy-production.yml` 调用独立的 `scripts/mirror-gitee.sh`。
- push 仍只执行一次；之后仅对只读 SHA 核验做最多 5 次、每次 5 秒的有界重试。
- 只有 Gitee `master` 精确等于 `DEPLOY_SHA` 才返回成功；空响应、错误 SHA、认证失败或持续限流最终都失败关闭。
- remote URL 不嵌入凭据；临时 AskPass 文件以 `0700` 创建并在退出时删除；日志不输出 token。

## 自动化验证

- 真实进程测试以假 Git 边界模拟 push 成功、连续两次 429、第三次返回目标 SHA。
- 测试断言只执行三次核验、最终成功且标准输出/错误不包含测试 token。
- 合并后的最终验收仍必须由真实 GitHub workflow 证明 Gitee SHA、Coolify `finished`、应用 `running:healthy` 和公开健康版本一致。
