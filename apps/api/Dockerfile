# ─────────────────────────────────────────────────────────────────
# NoteCloud API 镜像
#
# 构建上下文是**仓库根**（monorepo），不是 apps/api：
#   docker build -f apps/api/Dockerfile .
# ─────────────────────────────────────────────────────────────────
# syntax=docker/dockerfile:1

# ── 构建阶段 ─────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

# Prisma 的引擎需要 openssl；slim 镜像里没有
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /repo

# generate 不会真的连库，但 prisma.config.ts 要求这个变量存在
ENV DATABASE_URL="mysql://build:build@127.0.0.1:3306/build"

# 先只复制依赖清单，让这一层能被缓存
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# 再复制源码
COPY . .

# Prisma 客户端生成到 src/generated，随后被 tsup 打进 dist
RUN pnpm --filter @notecloud/api exec prisma generate
RUN pnpm --filter @notecloud/api run build

# 产出一个自包含目录（只含生产依赖 + dist + prisma）
RUN pnpm --filter @notecloud/api --prod deploy /out

# ── 运行阶段 ─────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    API_PORT=3000 \
    UPLOAD_DIR=/data/uploads

# curl 用于 HEALTHCHECK；openssl 是 Prisma 引擎的依赖（迁移要用）
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/uploads \
 && chown -R node:node /data

WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chown=node:node apps/api/docker-entrypoint.sh ./
RUN chmod +x ./docker-entrypoint.sh

# 不用 root 跑
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${API_PORT}/healthz" || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
