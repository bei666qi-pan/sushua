# 国内构建规范:基础镜像走 daocloud,npm 走 npmmirror
# Node 24 内置 node:sqlite,无原生依赖 → 无需编译链,构建快且稳定
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN npm config set registry https://registry.npmmirror.com
COPY package.json package-lock.json ./
# Coolify 会把运行时 env(含 NODE_ENV=production)注入为 build ARG,
# 显式 --include=dev 保证 typescript/tailwind 等构建依赖始终安装
RUN npm ci --include=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
# 运行阶段不需要 npm；移除其工具链攻击面，并精确安装已修复的 OpenSSL 包。
RUN apk add --no-cache --upgrade \
      libcrypto3=3.5.8-r0 \
      libssl3=3.5.8-r0 \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -Y off -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
