/**
 * 网络配置 — Tailscale 节点映射
 *
 * 原架构使用 WireGuard (10.10.0.x)，现改用 Tailscale (100.x.x.x)
 * 保持逻辑节点 ID 不变，映射到 Tailscale IP
 */

export type NodeId = 'mac-local' | 'silicon-valley' | 'windows' | 'tokyo';

export interface NodeConfig {
  id: NodeId;
  name: string;
  tailscaleIp: string;
  wireguardIp?: string; // 保留用于兼容
  role: 'master' | 'worker';
  enabled: boolean;
}

export const NODES: Record<NodeId, NodeConfig> = {
  'mac-local': {
    id: 'mac-local',
    name: 'lunnymacbook-pro',
    tailscaleIp: '100.114.56.105',
    wireguardIp: '10.10.0.5',
    role: 'master',
    enabled: true,
  },
  'silicon-valley': {
    id: 'silicon-valley',
    name: 'vm-0-6-debian',
    tailscaleIp: '100.80.67.125',
    wireguardIp: '10.10.0.2',
    role: 'worker',
    enabled: true,
  },
  'windows': {
    id: 'windows',
    name: 'win-taq1rm10mnf',
    tailscaleIp: '100.101.173.35',
    wireguardIp: '10.10.0.4',
    role: 'worker',
    enabled: true, // 已启用
  },
  'tokyo': {
    id: 'tokyo',
    name: 'tokyo-node',
    tailscaleIp: '', // 待添加
    wireguardIp: '10.10.0.3',
    role: 'worker',
    enabled: false,
  },
};

/**
 * 获取所有启用的节点 IP（排除本机）
 */
export function getActiveNodeIps(excludeLocal = true): string[] {
  return Object.values(NODES)
    .filter(node => node.enabled)
    .filter(node => !excludeLocal || node.id !== 'mac-local')
    .map(node => node.tailscaleIp)
    .filter(ip => ip !== '');
}

/**
 * 获取 Redis 主节点 IP
 * 优先使用硅谷节点，fallback 到本地
 */
export function getRedisMasterIp(): string {
  const sv = NODES['silicon-valley'];
  if (sv.enabled && sv.tailscaleIp) {
    return sv.tailscaleIp;
  }
  return '127.0.0.1'; // 本地 fallback
}

/**
 * 根据节点 ID 获取 IP
 */
export function getNodeIp(nodeId: NodeId): string | null {
  const node = NODES[nodeId];
  return node?.enabled ? node.tailscaleIp : null;
}

/**
 * 检查节点是否在线（通过 Tailscale）
 */
export async function checkNodeOnline(nodeId: NodeId): Promise<boolean> {
  const ip = getNodeIp(nodeId);
  if (!ip) return false;

  try {
    const proc = Bun.spawn(['ping', '-c', '1', '-W', '2', ip], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
