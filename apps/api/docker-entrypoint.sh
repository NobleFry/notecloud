#!/bin/sh
# API 容器入口。
#
# 两种模式：
#   1. 无参数（正常启动）：先迁移，再起服务
#   2. 有参数（docker compose run api <cmd>）：直接执行命令，不跑迁移
#
# 第 2 点很关键：`docker compose run` 会用本文件的 ENTRYPOINT，
# 如果无条件 exec node，那么 `run api tar ...` 这类一次性任务会被吞掉，
# 容器变成跑 API 服务器、永远不退出（备份脚本就是这样卡住的）。
set -e

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "› 应用数据库迁移 ..."
  ./node_modules/.bin/prisma migrate deploy

  echo "› 检查全文索引（Prisma 会把 ngram 索引当 drift 删掉）..."
  node dist/ensure-indexes.js
fi

echo "› 启动 API (port ${API_PORT:-3000}) ..."
exec node dist/index.js
