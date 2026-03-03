#!/usr/bin/env bun
/**
 * MemoV Sync Daemon
 * 基于 Perplexity 策略：Git 分支 + Redis Streams + WireGuard 复制
 */

import { spawn } from 'bun';
import Redis from 'ioredis';
import { watch } from 'fs';
import { createHash } from 'crypto';
import { readFile, writeFile } from 'fs/promises';

const REDIS_HOST = '10.10.0.1';
const REDIS_PORT = 6379;
const MEM_DIR = '.mem';
const NODES = ['10.10.0.2', '10.10.0.3', '10.10.0.4'];

const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

// SHA256 哈希
function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// Git 操作
async function gitCommit(message: string) {
  const proc = spawn(['git', '-C', MEM_DIR, 'add', '.']);
  await proc.exited;
  
  const commit = spawn(['git', '-C', MEM_DIR, 'commit', '-m', message]);
  await commit.exited;
  
  console.log(`[Git] Committed: ${message}`);
}

// WireGuard 复制到其他节点
async function syncToNodes() {
  for (const node of NODES) {
    const rsync = spawn([
      'rsync', '-avz', '--checksum',
      `${MEM_DIR}/shared/`,
      `root@${node}:${MEM_DIR}/shared/`
    ]);
    
    const exitCode = await rsync.exited;
    if (exitCode === 0) {
      console.log(`[Sync] Synced to ${node}`);
    } else {
      console.error(`[Sync] Failed to sync to ${node}`);
    }
  }
}

// 定期快照（30秒）
setInterval(async () => {
  try {
    await gitCommit(`snapshot ${Date.now()}`);
  } catch (err) {
    console.error('[Snapshot] Error:', err);
  }
}, 30000);

// 监听 Redis Streams
async function listenMemEvents() {
  let lastId = '$'; // 从最新开始
  
  while (true) {
    try {
      const events = await redis.xread(
        'BLOCK', 5000,
        'STREAMS', 'fsc:mem_events', lastId
      );
      
      if (!events) continue;
      
      for (const [stream, messages] of events) {
        for (const [id, fields] of messages) {
          lastId = id;
          
          const event = {
            type: fields[1],
            agent_id: fields[3],
            sha256: fields[5]
          };
          
          console.log('[Event]', event);
          
          if (event.type === 'context_update') {
            await syncToNodes();
          }
        }
      }
    } catch (err) {
      console.error('[Redis] Error:', err);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// 监听 shared/ 目录变更
watch(`${MEM_DIR}/shared`, { recursive: true }, async (event, filename) => {
  console.log(`[Watch] ${event}: ${filename}`);
  
  // 发布到 Redis
  await redis.xadd('fsc:mem_events', '*',
    'type', 'shared_update',
    'file', filename || 'unknown',
    'timestamp', Date.now().toString()
  );
});

// CAS 写入
export async function writeWithCAS(path: string, content: string): Promise<boolean> {
  const fullPath = `${MEM_DIR}/${path}`;
  
  try {
    const current = await readFile(fullPath, 'utf-8');
    const currentHash = sha256(current);
    const newHash = sha256(content);
    
    // Redis CAS
    const success = await redis.eval(`
      if redis.call('get', KEYS[1]) == ARGV[1] then
        redis.call('set', KEYS[1], ARGV[2])
        return 1
      else
        return 0
      end
    `, 1, `mem:${path}`, currentHash, newHash) as number;
    
    if (success === 1) {
      await writeFile(fullPath, content);
      await gitCommit(`update ${path} ${newHash.slice(0, 8)}`);
      return true;
    }
    
    return false;
  } catch (err) {
    console.error('[CAS] Error:', err);
    return false;
  }
}

// 启动
console.log('[MemoV Sync] Starting...');
console.log(`[Redis] ${REDIS_HOST}:${REDIS_PORT}`);
console.log(`[Nodes] ${NODES.join(', ')}`);

listenMemEvents();

// 优雅退出
process.on('SIGTERM', async () => {
  console.log('[MemoV Sync] Shutting down...');
  await gitCommit('shutdown snapshot');
  await redis.quit();
  process.exit(0);
});
