#!/bin/bash
# MemoV .mem/ git remote 初始化 + 多节点同步脚本

set -e

MEM_DIR="${MEM_DIR:-./.mem}"
REMOTE_NAME="${REMOTE_NAME:-memov-sync}"
REMOTE_URL="${REMOTE_URL:-git@github.com:2233admin/memov-sync.git}"
NODE_NAME="${NODE_NAME:-tokyo}"

echo "=== MemoV 同步初始化 ==="
echo "节点: $NODE_NAME"
echo "MemoV 目录: $MEM_DIR"
echo "远程仓库: $REMOTE_URL"

# 初始化 .mem 目录
if [ ! -d "$MEM_DIR" ]; then
  echo "创建 MemoV 目录: $MEM_DIR"
  mkdir -p "$MEM_DIR"
fi

cd "$MEM_DIR"

# 初始化 git 仓库（如果还没有）
if [ ! -d ".git" ]; then
  echo "初始化 Git 仓库"
  git init
  git config user.name "$NODE_NAME"
  git config user.email "$NODE_NAME@claw-mesh.local"
  echo "# MemoV Sync" > README.md
  git add README.md
  git commit -m "Initial commit: MemoV sync repository"
fi

# 添加远程仓库（如果还没有）
if ! git remote | grep -q "^$REMOTE_NAME$"; then
  echo "添加远程仓库: $REMOTE_NAME"
  git remote add "$REMOTE_NAME" "$REMOTE_URL"
fi

echo ""
echo "=== 初始化完成 ==="
echo ""
echo "同步命令:"
echo "  git fetch $REMOTE_NAME"
echo "  git merge $REMOTE_NAME/main --allow-unrelated-histories"
echo "  git push $REMOTE_NAME main"
echo ""
echo "下一步: 配置 SSH 密钥访问远程仓库"
