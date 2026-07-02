# 速刷 sushua

期末备考刷题网站:上传题库文件(PDF/Word/TXT)自动切题,速刷判分、速记背题、错题重刷,配 AI 流式解析。

线上地址:https://sushua.versecraft.cn

## 技术栈

- Next.js 15(App Router)+ TypeScript + Tailwind CSS 4,`output: 'standalone'` 单容器部署
- SQLite(better-sqlite3),数据文件 `$DATA_DIR/sushua.db`(生产挂持久卷 `/app/data`)
- DeepSeek(OpenAI 兼容)做 AI 解析与题库抽取兜底

## 核心机制

- **解析管线**:正则规则切题(零 AI 成本)→ 低置信段落分块调 DeepSeek JSON mode 兜底
- **无登录**:上传时生成 32 位 `owner_key` 存 localStorage,作为题库管理凭证;可见性 private / unlisted / public 三档
- **AI 成本三层防线**:按 `sha256(题干+选项)` 全站缓存;服务端小时熔断(≥9.5 元只回缓存,峰时 9-12/14-18 双倍计价);IP 限流(解析 10 次/分,上传兜底 5 次/时)
- **性能**:题目一次性下发,切题纯前端零请求;AI 解析 SSE 流式;静态资源全部自托管

## 本地开发

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 小时熔断逻辑单测
npm run build        # 生产构建
```

环境变量:`DEEPSEEK_API_KEY`(必需,AI 功能)、`DATA_DIR`(默认 ./data)、`DEEPSEEK_MODEL`(默认 deepseek-v4-flash)。

## 部署

GitHub → Gitee 镜像 → Coolify(Dockerfile 构建,基础镜像走 daocloud,npm 走 npmmirror),持久卷挂 `/app/data`,健康端点 `/api/health`。
