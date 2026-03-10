#!/usr/bin/env bun
/**
 * 测试 Tailscale 网络配置
 */
import { NODES, getActiveNodeIps, getRedisMasterIp, checkNodeOnline } from './config/network';

console.log('📡 Tailscale 网络配置\n');

console.log('所有节点:');
for (const [id, node] of Object.entries(NODES)) {
  const status = node.enabled ? '✅' : '❌';
  console.log(`  ${status} ${node.name} (${id})`);
  console.log(`     Tailscale: ${node.tailscaleIp || '未配置'}`);
  console.log(`     角色: ${node.role}`);
  console.log('');
}

console.log('活跃节点 IP:', getActiveNodeIps());
console.log('Redis 主节点:', getRedisMasterIp());

console.log('\n🔍 检查节点在线状态...');
for (const [id, node] of Object.entries(NODES)) {
  if (!node.enabled) continue;
  const online = await checkNodeOnline(id as any);
  console.log(`  ${online ? '🟢' : '🔴'} ${node.name}: ${online ? 'online' : 'offline'}`);
}
