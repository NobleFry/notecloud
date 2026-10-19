# ─────────────────────────────────────────────────────────────────
# NoteCloud Web 镜像：Vite 构建 + Nginx 托管（同时反代 /api）
#
# 构建上下文是**仓库根**（monorepo）：
#   docker build -f apps/web/Dockerfile .
# ─────────────────────────────────────────────────────────────────
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .

# vue-tsc 峰值约 600MB，1GB 内存的机器会把 Node 堆打满（Reached heap limit）。
# 默认仍做类型检查；内存不足时用 --build-arg TYPECHECK=0 跳过，
# 只跑 vite build（峰值 < 512MB），类型检查交给 CI。
ARG TYPECHECK=1
ENV NODE_OPTIONS=--max-old-space-size=1024
RUN if [ "$TYPECHECK" = "1" ]; then \
      pnpm --filter @notecloud/web run build; \
    else \
      pnpm --filter @notecloud/web exec vite build; \
    fi

FROM nginx:1.27-alpine AS runtime

# 用模板机制把 DNS 解析放在运行时（api 容器可能比 nginx 晚就绪）
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

ENV NGINX_ENTRYPOINT_QUIET_LOGS=1 \
    API_UPSTREAM=api:3000

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
