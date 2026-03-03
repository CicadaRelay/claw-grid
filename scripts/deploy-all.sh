#!/usr/bin/env bash
# ============================================
# Claw Mesh 三节点统一部署脚本
# Version: 1.0.0
# ============================================
#
# 功能：
# - 自动检测节点（硅谷/东京/中央）
# - 安装依赖
# - 配置 Docker + sysctl
# - 启动 Redis PEL 清理
# - 启动 FSC Worker
# - 启动 API 服务（LLM Proxy + MCP Proxy + Stream Chat）
#
# 使用：
#   ./deploy-all.sh [节点名称]
#
# 示例：
#   ./deploy-all.sh silicon    # 只部署硅谷
#   ./deploy-all.sh tokyo      # 只部署东京
#   ./deploy-all.sh central    # 只部署中央
#   ./deploy-all.sh all        # 部署所有节点
#
# ============================================

set -euo pipefail

# ============ 颜色输出 ============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
  echo -e "${BLUE}[STEP]${NC} $1"
}

# ============ 节点配置 ============
declare -A NODES
NODES[silicon]="170.106.73.160"
NODES[tokyo]="43.167.192.145"
NODES[central]="43.163.225.27"

# 自动检测当前节点
detect_node() {
  local current_ip=$(hostname -I | awk '{print $1}')
  
  for node in "${!NODES[@]}"; do
    if [[ "${NODES[$node]}" == "$current_ip" ]]; then
      echo "$node"
      return
    fi
  done
  
  echo "unknown"
}

CURRENT_NODE=$(detect_node)
TARGET_NODE="${1:-$CURRENT_NODE}"

log_info "Current node: $CURRENT_NODE"
log_info "Target node: $TARGET_NODE"

# ============ 检查依赖 ============
check_dependencies() {
  log_step "Checking dependencies..."
  
  local missing=()
  
  for cmd in docker redis-cli bun git; do
    if ! command -v $cmd &> /dev/null; then
      missing+=($cmd)
    fi
  done
  
  if [ ${#missing[@]} -gt 0 ]; then
    log_error "Missing dependencies: ${missing[*]}"
    log_info "Install with: yum install -y docker redis bun git"
    exit 1
  fi
  
  log_info "All dependencies satisfied"
}

# ============ 安装 Node 依赖 ============
install_node_deps() {
  log_step "Installing Node.js dependencies..."
  
  local project_dir="/root/.openclaw/workspace/claw-mesh"
  
  if [ "$CURRENT_NODE" == "silicon" ]; then
    project_dir="/root/.openclaw/workspace/claw-mesh-dev"
  fi
  
  cd "$project_dir"
  
  # 安装根目录依赖
  if [ -f "package.json" ]; then
    log_info "Installing root dependencies..."
    bun install
  fi
  
  # 安装前端依赖（仅硅谷）
  if [ "$CURRENT_NODE" == "silicon" ] && [ -d "frontend/claw-mesh-dashboard" ]; then
    log_info "Installing frontend dependencies..."
    cd frontend/claw-mesh-dashboard
    npm install
    cd ../..
  fi
  
  log_info "Node.js dependencies installed"
}

# ============ 配置 Docker ============
configure_docker() {
  log_step "Configuring Docker..."
  
  local project_dir="/root/.openclaw/workspace/claw-mesh"
  if [ "$CURRENT_NODE" == "silicon" ]; then
    project_dir="/root/.openclaw/workspace/claw-mesh-dev"
  fi
  
  # 备份现有配置
  if [ -f "/etc/docker/daemon.json" ]; then
    log_warn "Backing up existing daemon.json"
    cp /etc/docker/daemon.json /etc/docker/daemon.json.bak
  fi
  
  # 复制新配置
  cp "$project_dir/config/docker-daemon.json" /etc/docker/daemon.json
  log_info "Docker daemon.json configured"
  
  # 重启 Docker
  log_info "Restarting Docker..."
  systemctl restart docker
  
  # 等待 Docker 启动
  sleep 3
  
  if systemctl is-active --quiet docker; then
    log_info "Docker restarted successfully"
  else
    log_error "Docker failed to restart"
    exit 1
  fi
}

# ============ 配置 sysctl ============
configure_sysctl() {
  log_step "Configuring sysctl..."
  
  local project_dir="/root/.openclaw/workspace/claw-mesh"
  if [ "$CURRENT_NODE" == "silicon" ]; then
    project_dir="/root/.openclaw/workspace/claw-mesh-dev"
  fi
  
  # 复制配置
  cp "$project_dir/config/99-wireguard-docker.conf" /etc/sysctl.d/
  
  # 应用配置
  sysctl -p /etc/sysctl.d/99-wireguard-docker.conf
  
  log_info "sysctl configured"
}

# ============ 启动 Redis PEL 清理 ============
setup_redis_pel_cleanup() {
  log_step "Setting up Redis PEL cleanup..."
  
  local project_dir="/root/.openclaw/workspace/claw-mesh"
  if [ "$CURRENT_NODE" == "silicon" ]; then
    project_dir="/root/.openclaw/workspace/claw-mesh-dev"
  fi
  
  # 复制脚本
  cp "$project_dir/scripts/redis-pel-cleanup.sh" /usr/local/bin/
  chmod +x /usr/local/bin/redis-pel-cleanup.sh
  
  # 添加 cron（如果不存在）
  if ! crontab -l 2>/dev/null | grep -q "redis-pel-cleanup.sh"; then
    (crontab -l 2>/dev/null; echo "*/1 * * * * /usr/local/bin/redis-pel-cleanup.sh >> /var/log/redis-pel-cleanup.log 2>&1") | crontab -
    log_info "Redis PEL cleanup cron added"
  else
    log_info "Redis PEL cleanup cron already exists"
  fi
}

# ============ 启动 FSC Worker ============
start_fsc_worker() {
  log_step "Starting FSC Worker..."
  
  local project_dir="/root/.openclaw/workspace/claw-mesh"
  if [ "$CURRENT_NODE" == "silicon" ]; then
    project_dir="/root/.openclaw/workspace/claw-mesh-dev"
  fi
  
  # 检查 PM2
  if ! command -v pm2 &> /dev/null; then
    log_warn "PM2 not found, installing..."
    npm install -g pm2
  fi
  
  # 停止旧进程
  pm2 delete fsc-worker 2>/dev/null || true
  
  # 启动新进程
  cd "$project_dir/fsc"
  pm2 start fsc-worker-daemon.ts --name fsc-worker
  pm2 save
  
  log_info "FSC Worker started"
}

# ============ 启动 API 服务 ============
start_api_services() {
  log_step "Starting API services..."
  
  local project_dir="/root/.openclaw/workspace/claw-mesh"
  if [ "$CURRENT_NODE" == "silicon" ]; then
    project_dir="/root/.openclaw/workspace/claw-mesh-dev"
  fi
  
  cd "$project_dir/api"
  
  # 停止旧进程
  pm2 delete llm-proxy 2>/dev/null || true
  pm2 delete memov-mcp-proxy 2>/dev/null || true
  pm2 delete stream-chat 2>/dev/null || true
  
  # 启动新进程
  pm2 start llm-proxy.ts --name llm-proxy
  pm2 start memov-mcp-proxy.ts --name memov-mcp-proxy
  pm2 start stream-chat.ts --name stream-chat
  pm2 save
  
  log_info "API services started"
}

# ============ 验证部署 ============
verify_deployment() {
  log_step "Verifying deployment..."
  
  # 检查 Docker
  if ! docker ps &> /dev/null; then
    log_error "Docker not running"
    return 1
  fi
  log_info "✓ Docker running"
  
  # 检查 Redis PEL 清理
  if ! crontab -l | grep -q "redis-pel-cleanup.sh"; then
    log_error "Redis PEL cleanup cron not found"
    return 1
  fi
  log_info "✓ Redis PEL cleanup configured"
  
  # 检查 FSC Worker
  if ! pm2 list | grep -q "fsc-worker.*online"; then
    log_error "FSC Worker not running"
    return 1
  fi
  log_info "✓ FSC Worker running"
  
  # 检查 API 服务
  if ! pm2 list | grep -q "llm-proxy.*online"; then
    log_error "LLM Proxy not running"
    return 1
  fi
  log_info "✓ LLM Proxy running"
  
  if ! pm2 list | grep -q "memov-mcp-proxy.*online"; then
    log_error "MemoV MCP Proxy not running"
    return 1
  fi
  log_info "✓ MemoV MCP Proxy running"
  
  if ! pm2 list | grep -q "stream-chat.*online"; then
    log_error "Stream Chat not running"
    return 1
  fi
  log_info "✓ Stream Chat running"
  
  log_info "Deployment verification complete"
}

# ============ 远程部署 ============
deploy_remote() {
  local node=$1
  local ip=${NODES[$node]}
  
  log_info "Deploying to $node ($ip)..."
  
  # 复制脚本到远程节点
  scp "$0" root@$ip:/tmp/deploy-all.sh
  
  # 在远程节点执行
  ssh root@$ip "bash /tmp/deploy-all.sh $node"
  
  log_info "Remote deployment to $node complete"
}

# ============ 主流程 ============
main() {
  log_info "Starting Claw Mesh deployment..."
  log_info "Target: $TARGET_NODE"
  
  # 如果是 all，部署所有节点
  if [ "$TARGET_NODE" == "all" ]; then
    for node in "${!NODES[@]}"; do
      if [ "$node" == "$CURRENT_NODE" ]; then
        # 本地部署
        check_dependencies
        install_node_deps
        configure_docker
        configure_sysctl
        setup_redis_pel_cleanup
        start_fsc_worker
        start_api_services
        verify_deployment
      else
        # 远程部署
        deploy_remote "$node"
      fi
    done
    
    log_info "All nodes deployed successfully"
    return
  fi
  
  # 如果目标节点不是当前节点，远程部署
  if [ "$TARGET_NODE" != "$CURRENT_NODE" ]; then
    deploy_remote "$TARGET_NODE"
    return
  fi
  
  # 本地部署
  check_dependencies
  install_node_deps
  configure_docker
  configure_sysctl
  setup_redis_pel_cleanup
  start_fsc_worker
  start_api_services
  verify_deployment
  
  log_info "Deployment complete!"
  log_info "Next steps:"
  log_info "  1. Check FSC Worker logs: pm2 logs fsc-worker"
  log_info "  2. Check API logs: pm2 logs llm-proxy"
  log_info "  3. Test Redis PEL cleanup: tail -f /var/log/redis-pel-cleanup.log"
  log_info "  4. Monitor: pm2 monit"
}

main "$@"
