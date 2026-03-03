#!/bin/bash
# 部署 FSC Worker 到所有节点

NODES=(
  "root@43.163.225.27:中央"
  "root@43.167.192.145:东京"
  "curry@10.10.0.4:CURRYCLAW"
)

FSC_DIR="$HOME/.openclaw/workspace/fsc"

echo "🚀 部署 FSC Worker Daemon 到所有节点"
echo ""

for node in "${NODES[@]}"; do
  NODE_ADDR="${node%%:*}"
  NODE_NAME="${node##*:}"
  
  echo "📦 部署到 $NODE_NAME ($NODE_ADDR)"
  
  # 同步文件
  rsync -avz --delete \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude '.mem/.git' \
    "$FSC_DIR/" \
    "$NODE_ADDR:.openclaw/workspace/fsc/" \
    2>&1 | grep -E "(sending|total size)" || echo "  ✓ 已同步"
  
  # 安装依赖并启动
  ssh "$NODE_ADDR" "cd .openclaw/workspace/fsc && bun install && echo '✓ 依赖已安装'"
  
  echo ""
done

echo "✅ 部署完成！"
echo ""
echo "启动 Worker："
echo "  ssh <node> 'cd .openclaw/workspace/fsc && ./start-worker.sh'"
