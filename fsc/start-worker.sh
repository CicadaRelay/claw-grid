#!/bin/bash
# FSC Worker Daemon 启动脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 加载环境变量
if [ -f .env.worker ]; then
  export $(cat .env.worker | grep -v '^#' | xargs)
fi

# 安装依赖（如果需要）
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  bun install
fi

# 启动 worker
echo "Starting FSC Worker Daemon..."
echo "Redis: ${REDIS_HOST}:${REDIS_PORT}"
echo "Max concurrent: ${MAX_CONCURRENT}"

bun run fsc-worker-daemon.ts
