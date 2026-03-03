#!/bin/bash
# WireGuard 密钥对批量生成脚本
# 输入: node数量 + IP列表（格式: node1:pub_ip1:wg_ip1 node2:pub_ip2:wg_ip2 ...）
# 输出: 每节点wg0.conf

set -e

if [ $# -lt 1 ]; then
  echo "用法: $0 <node_spec>..."
  echo "node_spec 格式: <name>:<public_ip>:<wireguard_ip>"
  echo ""
  echo "示例:"
  echo "  $0 central:43.163.225.27:10.0.0.1 tokyo:43.167.192.145:10.0.0.2 sv:170.106.73.160:10.0.0.3"
  exit 1
fi

WG_PORT=51820
OUTPUT_DIR="./configs/wireguard"

mkdir -p "$OUTPUT_DIR"

echo "=== 生成 $# 个 WireGuard 密钥对 ==="

# 解析节点配置
declare -A NODE_NAMES
declare -A NODE_PUBLIC_IPS
declare -A NODE_WG_IPS
declare -A NODE_PRIVATE_KEYS
declare -A NODE_PUBLIC_KEYS

index=0
for spec in "$@"; do
  IFS=':' read -r name public_ip wg_ip <<< "$spec"
  NODE_NAMES[$index]="$name"
  NODE_PUBLIC_IPS[$name]="$public_ip"
  NODE_WG_IPS[$name]="$wg_ip"
  index=$((index + 1))
  echo "节点: $name | 公网IP: $public_ip | WireGuardIP: $wg_ip"
done

echo ""

# 先生成所有节点的密钥
for name in "${NODE_NAMES[@]}"; do
  echo "生成密钥: $name"
  private_key=$(wg genkey)
  public_key=$(echo "$private_key" | wg pubkey)
  NODE_PRIVATE_KEYS[$name]="$private_key"
  NODE_PUBLIC_KEYS[$name]="$public_key"
  
  # 保存密钥
  echo "$private_key" > "$OUTPUT_DIR/${name}_private.key"
  echo "$public_key" > "$OUTPUT_DIR/${name}_public.key"
  chmod 600 "$OUTPUT_DIR/${name}_private.key"
done

echo ""

# 生成每个节点的 wg0.conf
for name in "${NODE_NAMES[@]}"; do
  echo "生成配置: $name"
  
  private_key=${NODE_PRIVATE_KEYS[$name]}
  wg_ip=${NODE_WG_IPS[$name]}
  public_ip=${NODE_PUBLIC_IPS[$name]}

  cat > "$OUTPUT_DIR/${name}_wg0.conf" <<EOF
[Interface]
PrivateKey = $private_key
Address = $wg_ip/24
ListenPort = $WG_PORT
DNS = 8.8.8.8, 8.8.4.4

EOF

  # 添加所有 peer
  for peer_name in "${NODE_NAMES[@]}"; do
    if [ "$peer_name" != "$name" ]; then
      peer_wg_ip=${NODE_WG_IPS[$peer_name]}
      peer_public_ip=${NODE_PUBLIC_IPS[$peer_name]}
      peer_public_key=${NODE_PUBLIC_KEYS[$peer_name]}
      cat >> "$OUTPUT_DIR/${name}_wg0.conf" <<EOF
[Peer]
PublicKey = $peer_public_key
AllowedIPs = $peer_wg_ip/32
Endpoint = $peer_public_ip:$WG_PORT
PersistentKeepalive = 25

EOF
    fi
  done

  echo "✓ $name 配置生成完成"
done

echo ""
echo "=== 配置生成完成 ==="
echo "输出目录: $OUTPUT_DIR"
echo ""
echo "配置文件列表："
for name in "${NODE_NAMES[@]}"; do
  echo "  - $OUTPUT_DIR/${name}_wg0.conf"
done
echo ""
echo "下一步："
echo "1. 复制 wg0.conf 到对应节点的 /etc/wireguard/wg0.conf"
echo "2. 在每个节点启动: wg-quick up wg0"
echo "3. 验证连通性: ping <peer_wg_ip>"
