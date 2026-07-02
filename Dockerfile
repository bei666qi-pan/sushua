# 国内构建规范:基础镜像走 daocloud,npm 走 npmmirror,不用 apt
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:20-alpine

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# better-sqlite3 需要原生编译(国内拉不到 GitHub 预编译包),用 apk 装编译链,源换阿里云
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g' /etc/apk/repositories \
  && apk add --no-cache python3 make g++
RUN npm config set registry https://registry.npmmirror.com
COPY package.json package-lock.json ./
# Coolify 会把运行时 env(含 NODE_ENV=production)注入为 build ARG,
# 显式 --include=dev 保证 typescript/tailwind 等构建依赖始终安装
RUN npm ci --include=dev

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
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
RUN mkdir -p /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
